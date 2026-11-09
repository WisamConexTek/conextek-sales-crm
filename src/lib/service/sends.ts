import { z } from "zod";
import { createHash } from "node:crypto";
import { all, one, run, tx, now, type Row } from "../db";
import { HttpError, can, isManager, requirePerm, type Actor } from "../auth";
import { audit, parse, optText, optInt, parseEventDate, dateProblem } from "./common";
import { assertLeadAccess, leadScope } from "./leads";
import { assertChannel } from "./campaigns";
import { capacityData } from "./capacity";
import { loadSenders, detectLanguage, resolveSender, capOn, type Sender, type Step } from "./senders";
import { todayYmd } from "../db";

/**
 * Message versions, scoped authorizations, send confirmation and recording.
 * The CRM never sends anything. A "confirmed send" is a report that the browser workflow already sent the message.
 */

/** Test seam: make the next N recordings fail, to prove SENT_CONFIRMED_CRM_PENDING reconciles without a resend. */
export const testHooks = { failRecording: 0 };

const ACTIONS = ["first_email", "follow_up", "other"] as const;
const PRE_CONTACT_STAGES = ["new", "researching", "ready"];

/* ---------- versions ---------- */
const hash = (subject: string | null, body: string) => createHash("sha256").update(`${subject ?? ""}\n${body}`).digest("hex");

export async function createVersion(actor: Actor, input: unknown) {
  requirePerm(actor, "activity.record");
  const d = parse(z.object({ lead_id: z.coerce.number().int(), contact_id: optInt.optional(), channel: z.string().min(1), campaign_id: z.coerce.number().int(), task_id: optInt.optional(), subject: optText(300).optional(), body: z.string().trim().min(1, "required").max(20000), sender_id: optInt.optional(), sender_email: optText(200).optional(), language: z.enum(["en", "ar", "zh"]).nullable().optional() }), input);
  const lead = await assertLeadAccess(actor, d.lead_id);
  await assertChannel(d.channel);
  if (!(await one("SELECT id FROM campaigns WHERE id=?", [d.campaign_id]))) throw new HttpError(400, "campaign_id: unknown campaign.");
  if (d.contact_id && !(await one("SELECT id FROM contacts WHERE id=? AND lead_id=?", [d.contact_id, d.lead_id]))) throw new HttpError(400, "contact_id: not a contact of this lead.");
  const subject = d.subject ?? null;
  const prev = await one("SELECT id,version,content_hash FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? ORDER BY version DESC LIMIT 1", [d.lead_id, d.contact_id ?? 0, d.channel, d.campaign_id]);
  const h = hash(subject, d.body);
  if (prev && prev.content_hash === h && (!(d.sender_id || d.sender_email) || (await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email })) === ((await one("SELECT sender_id FROM message_versions WHERE id=?", [prev.id as number]))?.sender_id as number))) return { id: prev.id as number, version: prev.version as number, created: false };
  const version = ((prev?.version as number) ?? 0) + 1;
  // The sender: named explicitly, else the one this thread already uses, else the one that already wrote to this lead, else the default mailbox.
  let senderId = await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email });
  if (!senderId && prev) senderId = ((await one("SELECT sender_id FROM message_versions WHERE id=?", [prev.id as number]))?.sender_id as number) ?? null;
  if (!senderId) senderId = ((await one("SELECT COALESCE(sender_id,1) AS s FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' AND is_demo=0 ORDER BY occurred_at DESC,id DESC LIMIT 1", [d.lead_id]))?.s as number) ?? 1;
  const language = d.language ?? detectLanguage(`${subject ?? ""} ${d.body}`);
  if (d.task_id == null && prev) { const pt = await one("SELECT task_id FROM message_versions WHERE id=?", [prev.id as number]); if (pt?.task_id) d.task_id = pt.task_id as number; }
  const r = await run("INSERT INTO message_versions (lead_id,contact_id,channel,campaign_id,task_id,version,subject,body,content_hash,created_by,created_at,sender_id,language) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [d.lead_id, d.contact_id ?? null, d.channel, d.campaign_id, d.task_id ?? null, version, subject, d.body, h, actor.id, now(), senderId, language]);
  // An edit voids every still-active authorization of the earlier versions of this thread.
  const voided = await run("UPDATE send_authorizations SET status='revoked' WHERE status='active' AND message_version_id IN (SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? AND id<>?)", [d.lead_id, d.contact_id ?? 0, d.channel, d.campaign_id, r.id]);
  await audit(actor, "create_message_version", "message_version", r.id, { lead_id: d.lead_id, version, sender_id: senderId, language, revoked_authorizations: voided.changes, is_test: !!lead.is_demo });
  await syncTasks(actor, r.id);
  return { id: r.id, version, created: true };
}

export async function getVersion(actor: Actor, id: number) {
  const v = await one("SELECT * FROM message_versions WHERE id=?", [id]);
  if (!v) throw new HttpError(404, "Message version not found.");
  await assertLeadAccess(actor, v.lead_id as number);
  const latest = await latestVersion(v);
  const auths = await all("SELECT a.id,a.kind,a.permitted_action,a.status,a.approver_id,u.name AS approver_name,a.note,a.created_at,a.used_at FROM send_authorizations a JOIN users u ON u.id=a.approver_id WHERE a.message_version_id=? ORDER BY a.id", [id]);
  const decisions = await all("SELECT d.id,d.kind,d.reason,d.new_version_id,u.name AS decided_by,d.created_at FROM message_decisions d JOIN users u ON u.id=d.decided_by WHERE d.message_version_id=? ORDER BY d.id", [id]);
  const sender = await one("SELECT id,email,display_name FROM senders WHERE id=?", [v.sender_id as number]);
  return { ...v, sender, is_latest: latest === v.id, authorizations: auths, decisions } as Row & { is_latest: boolean; authorizations: Row[]; decisions: Row[] };
}
async function latestVersion(v: Row) {
  const r = await one("SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? ORDER BY version DESC LIMIT 1", [v.lead_id, v.contact_id ?? 0, v.channel, v.campaign_id]);
  return r!.id as number;
}

/* ---------- authorizations ---------- */
/** Who may create SEND authorizations: the Owner, or the one Chief the Owner has delegated to (switchable at any time). */
const DELEGATE_KEY = "send_delegate_user_id";
export async function getSendDelegate(): Promise<number | null> {
  const r = await one("SELECT value FROM app_settings WHERE key=?", [DELEGATE_KEY]);
  return r?.value ? Number(r.value) : null;
}
export async function canAuthorizeSend(actor: Actor): Promise<boolean> {
  if (actor.role === "owner") return true;
  return actor.role === "chief" && (await getSendDelegate()) === actor.id;
}
export async function setSendDelegation(actor: Actor, userId: number | null) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change who may approve sends.");
  if (userId != null) {
    const u = await one("SELECT id,role,active,name FROM users WHERE id=?", [userId]);
    if (!u || !u.active) throw new HttpError(400, "user_id: unknown or disabled user.");
    if (u.role !== "chief") throw new HttpError(400, "user_id: send approval can only be delegated to a Chief.");
  }
  const from = await getSendDelegate();
  await run("INSERT INTO app_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [DELEGATE_KEY, userId == null ? null : String(userId), actor.id, now()]);
  await audit(actor, userId == null ? "send_delegation_off" : "send_delegation_on", "user", userId ?? from ?? 0, { from, to: userId });
  return { delegate_user_id: userId };
}
export async function sendDelegationStatus() {
  const id = await getSendDelegate();
  const u = id ? await one("SELECT id,name,username FROM users WHERE id=?", [id]) : null;
  return { enabled: !!id, delegate_user_id: id, delegate_name: (u?.name as string) ?? null };
}

export async function authorize(actor: Actor, input: unknown) {
  const d = parse(z.object({ message_version_id: z.coerce.number().int(), kind: z.enum(["editorial", "send"]), permitted_action: z.enum(ACTIONS), note: optText(500).optional() }), input);
  if (d.kind === "send") { if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Only the Owner (or the Chief the Owner has delegated to) can authorize a send. A Chief's editorial approval is not permission to send."); }
  else if (!can(actor, "approvals.decide") && actor.role !== "owner") throw new HttpError(403, "Editorial approval needs approvals.decide (Chief or Owner).");
  const v = await one("SELECT * FROM message_versions WHERE id=?", [d.message_version_id]);
  if (!v) throw new HttpError(400, "message_version_id: unknown version.");
  if ((await latestVersion(v)) !== v.id) throw new HttpError(409, "That is not the latest version of this message. Review the newest version; authorization never carries over to edited text.");
  const same = await one("SELECT id FROM send_authorizations WHERE message_version_id=? AND kind=? AND permitted_action=? AND status='active'", [v.id as number, d.kind, d.permitted_action]);
  if (same) return { id: same.id as number, created: false };
  const delegated = d.kind === "send" && actor.role !== "owner" ? 1 : 0;
  const r = await run("INSERT INTO send_authorizations (message_version_id,lead_id,contact_id,channel,campaign_id,kind,permitted_action,approver_id,note,created_at,delegated) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [v.id as number, v.lead_id as number, (v.contact_id as number) ?? null, v.channel as string, v.campaign_id as number, d.kind, d.permitted_action, actor.id, d.note ?? null, now(), delegated]);
  await audit(actor, delegated ? "authorize_send_delegated" : `authorize_${d.kind}`, "message_version", v.id as number, { authorization_id: r.id, action: d.permitted_action, ...(delegated ? { delegated: true, approver: actor.name } : {}) });
  await syncTasks(actor, v.id as number);
  return { id: r.id, created: true };
}

/* ---------- send-approval queue (Owner / delegate) ---------- */
const LATEST = "v.id = (SELECT v2.id FROM message_versions v2 WHERE v2.lead_id=v.lead_id AND COALESCE(v2.contact_id,0)=COALESCE(v.contact_id,0) AND v2.channel=v.channel AND v2.campaign_id=v.campaign_id ORDER BY v2.version DESC LIMIT 1)";
const WAITING = `${LATEST} AND l.is_demo=0 AND NOT EXISTS (SELECT 1 FROM send_authorizations a WHERE a.message_version_id=v.id AND a.kind='send' AND a.status IN ('active','used')) AND NOT EXISTS (SELECT 1 FROM message_decisions d WHERE d.message_version_id=v.id AND d.kind='rejected')`;

export async function countPendingSendApprovals(): Promise<number> {
  return Number((await one(`SELECT COUNT(*) AS n FROM message_versions v JOIN leads l ON l.id=v.lead_id WHERE ${WAITING}`))!.n);
}

/** Dashboard card: how many versions wait for the Owner's send approval, and the first few. Null for people who cannot approve sends. */
export async function sendApprovalPreview(actor: Actor, limit = 5) {
  if (!(await canAuthorizeSend(actor))) return null;
  const items = await all(`SELECT v.id,v.version,v.lead_id,v.channel,v.subject,l.company,c.name AS campaign FROM message_versions v JOIN leads l ON l.id=v.lead_id JOIN campaigns c ON c.id=v.campaign_id WHERE ${WAITING} ORDER BY v.created_at, v.id LIMIT ?`, [limit]);
  return { count: await countPendingSendApprovals(), items };
}

function suggestAction(taskAction: string | null, priorFirst: number): (typeof ACTIONS)[number] {
  const t = (taskAction ?? "").toLowerCase();
  if (t.includes("follow")) return "follow_up";
  if (t.includes("first")) return "first_email";
  return priorFirst > 0 ? "follow_up" : "first_email";
}

/** Latest versions that nobody has authorized to send yet, with everything needed to decide. */
export async function pendingSendApprovals(actor: Actor) {
  if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Only the Owner (or the delegated Chief) can approve sends.");
  const rows = await all(
    `SELECT v.id,v.version,v.lead_id,v.contact_id,v.channel,v.campaign_id,v.task_id,v.subject,v.body,v.created_at,v.sender_id,v.language,l.company,c.name AS campaign,
            ct.name AS recipient_name,ct.email AS recipient_email,u.name AS prepared_by,t.action_type,sd.email AS sender_email,sd.display_name AS sender_name
     FROM message_versions v JOIN leads l ON l.id=v.lead_id JOIN campaigns c ON c.id=v.campaign_id JOIN users u ON u.id=v.created_by
     LEFT JOIN contacts ct ON ct.id=v.contact_id LEFT JOIN tasks t ON t.id=v.task_id LEFT JOIN senders sd ON sd.id=v.sender_id
     WHERE ${WAITING} ORDER BY v.created_at, v.id LIMIT 200`);
  const ctx = await loadEligCtx(rows);
  const approverIds = [...new Set(rows.flatMap((v) => (ctx.auths.get(v.id as number) ?? []).filter((a) => a.kind === "editorial" && a.status === "active").map((a) => a.approver_id as number)))];
  const names = new Map<number, string>(approverIds.length ? (await all(`SELECT id,name FROM users WHERE id IN (${inList(approverIds)})`, approverIds)).map((u) => [u.id as number, u.name as string]) : []);
  const out: Row[] = [];
  for (const v of rows) {
    const ed = [...(ctx.auths.get(v.id as number) ?? [])].reverse().find((a) => a.kind === "editorial" && a.status === "active");
    const el = evaluateEligibility(v, ctx);
    out.push({
      ...v,
      editorial_status: ed ? `Reviewed by ${names.get(ed.approver_id as number)}` : "Not yet reviewed",
      editorial_reviewed: !!ed,
      suggested_action: suggestAction(v.action_type as string | null, ctx.firstSent.get(`${v.lead_id}|${v.channel}`) ?? 0),
      other_blockers: el.reasons.filter((r) => !r.startsWith("no active Owner send authorization")),
      warnings: el.warnings,
    } as Row);
  }
  return out;
}

/** Owner/delegate rejects a draft with a reason. The version stays on record; agents read the reason and prepare a new version. */
export async function rejectVersion(actor: Actor, versionId: number, reason: unknown) {
  if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Only the Owner (or the delegated Chief) can reject a draft.");
  const why = parse(z.string().trim().min(3, "reason: say why, so the agents understand").max(2000), reason);
  const v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  if ((await latestVersion(v)) !== v.id) throw new HttpError(409, "A newer version exists; reject that one instead.");
  if (await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='used'", [versionId])) throw new HttpError(409, "This version was already sent.");
  if (await one("SELECT 1 AS x FROM message_decisions WHERE message_version_id=? AND kind='rejected'", [versionId])) throw new HttpError(409, "Already rejected.");
  const delegated = actor.role !== "owner" ? 1 : 0;
  await tx([
    { sql: "INSERT INTO message_decisions (message_version_id,kind,reason,decided_by,delegated,created_at) VALUES (?,?,?,?,?,?)", args: [versionId, "rejected", why, actor.id, delegated, now()] },
    { sql: "UPDATE send_authorizations SET status='revoked' WHERE message_version_id=? AND status='active'", args: [versionId] },
  ]);
  await audit(actor, "reject_message_version", "message_version", versionId, { lead_id: v.lead_id, reason: why, delegated: !!delegated });
  await syncTasks(actor, versionId);
  return { message_version_id: versionId, status: "rejected" };
}

/** Owner/delegate edits the text directly. This creates a NEW immutable version (older approvals are voided). The new version still needs approval. */
export async function editVersion(actor: Actor, versionId: number, input: unknown) {
  if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Only the Owner (or the delegated Chief) can edit a draft here.");
  const d = parse(z.object({ subject: optText(300).optional(), body: z.string().trim().min(1, "required").max(20000), note: optText(2000).optional(), sender_id: optInt.optional(), sender_email: optText(200).optional() }), input);
  const v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  if ((await latestVersion(v)) !== v.id) throw new HttpError(409, "A newer version exists; edit that one.");
  if (await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='used'", [versionId])) throw new HttpError(409, "This version was already sent and cannot be edited.");
  const r = await createVersion(actor, { lead_id: v.lead_id, contact_id: v.contact_id, channel: v.channel, campaign_id: v.campaign_id, task_id: v.task_id, subject: d.subject ?? v.subject, body: d.body, sender_id: (await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email })) ?? (v.sender_id as number) });
  if (!r.created) throw new HttpError(400, "Nothing changed: the text is identical to this version.");
  await run("INSERT INTO message_decisions (message_version_id,kind,reason,new_version_id,decided_by,delegated,created_at) VALUES (?,?,?,?,?,?,?)", [versionId, "edited", d.note ?? null, r.id, actor.id, actor.role !== "owner" ? 1 : 0, now()]);
  await audit(actor, "edit_message_version", "message_version", versionId, { lead_id: v.lead_id, new_version_id: r.id, note: d.note ?? null });
  return { old_version_id: versionId, new_version_id: r.id, version: r.version };
}

/** Read-only list of message versions with their approval state, eligibility, linked task and recipient. */
export const VERSION_STATUSES = ["waiting_editorial", "waiting_send", "approved", "sent", "rejected", "superseded"] as const;
export async function listVersions(actor: Actor, q: { campaign_id?: number; lead_id?: number; status?: string; sender_id?: number; limit?: number; page?: number; latest_only?: boolean } = {}) {
  if (q.status && !(VERSION_STATUSES as readonly string[]).includes(q.status)) throw new HttpError(400, `status: one of ${VERSION_STATUSES.join(", ")}.`);
  const sc = leadScope(actor, "l");
  const where = [sc.sql, "l.is_demo=0"];
  const args: (string | number)[] = [...(sc.args as (string | number)[])];
  if (q.campaign_id) (where.push("v.campaign_id=?"), args.push(q.campaign_id));
  if (q.lead_id) (where.push("v.lead_id=?"), args.push(q.lead_id));
  if (q.sender_id) (where.push("v.sender_id=?"), args.push(q.sender_id));
  if (q.latest_only) where.push(LATEST);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  const rows = await all(
    `SELECT v.*, l.company, c.name AS campaign, ct.name AS recipient_name, ct.email AS recipient_email, u.name AS created_by_name, sd.email AS sender_email, sd.display_name AS sender_name,
            COALESCE((SELECT t.id FROM tasks t WHERE t.message_version_id=v.id ORDER BY t.id LIMIT 1), v.task_id) AS linked_task_id
     FROM message_versions v JOIN leads l ON l.id=v.lead_id JOIN campaigns c ON c.id=v.campaign_id JOIN users u ON u.id=v.created_by LEFT JOIN contacts ct ON ct.id=v.contact_id LEFT JOIN senders sd ON sd.id=v.sender_id
     WHERE ${where.join(" AND ")} ORDER BY v.id DESC LIMIT ? OFFSET ?`, [...args, q.status ? 500 : limit, q.status ? 0 : (page - 1) * limit]);
  const ctx = await loadEligCtx(rows);
  const out = rows.map((v) => {
    const id = v.id as number;
    const as = ctx.auths.get(id) ?? [];
    const last = (kind: string) => [...as].reverse().find((a) => a.kind === kind);
    const ed = last("editorial"), sd = last("send");
    const isLatest = ctx.latest.get(id) === id;
    const rejected = ctx.rejected.has(id);
    const sent = as.some((a) => a.kind === "send" && a.status === "used");
    const el = evaluateEligibility(v, ctx);
    const status = sent ? "sent" : rejected ? "rejected" : !isLatest ? "superseded" : !(ed?.status === "active") ? "waiting_editorial" : !(sd?.status === "active") ? "waiting_send" : "approved";
    return {
      id, version: v.version, is_latest: isLatest, status, lead_id: v.lead_id, company: v.company, campaign_id: v.campaign_id, campaign: v.campaign, channel: v.channel,
      contact_id: v.contact_id, recipient: v.contact_id ? { name: v.recipient_name, email: v.recipient_email } : null, subject: v.subject, task_id: v.linked_task_id ?? null,
      created_by: v.created_by_name, created_at: v.created_at, sender_id: v.sender_id, sender: { id: v.sender_id, email: v.sender_email, name: v.sender_name }, language: v.language ?? detectLanguage(`${v.subject ?? ""} ${v.body}`),
      editorial_status: ed ? (ed.status === "active" ? "approved" : ed.status) : "not_reviewed",
      send_status: sd ? (sd.status === "active" ? "approved" : sd.status) : "not_approved",
      rejected, eligibility: { eligible: el.reasons.length === 0, reasons: el.reasons, codes: el.codes },
    };
  });
  const filtered = q.status ? out.filter((r) => r.status === q.status) : out;
  return q.status ? filtered.slice((page - 1) * limit, page * limit) : filtered;
}

/** Who authorized what, when, for exactly which version. */
export async function versionAuthorizations(actor: Actor, id: number) {
  const v = await getVersion(actor, id);
  const auths = await all("SELECT a.id,a.kind,a.permitted_action,a.status,a.delegated,a.approver_id,u.name AS approver_name,a.note,a.channel,a.campaign_id,a.contact_id,a.created_at,a.used_at,a.send_event_id FROM send_authorizations a JOIN users u ON u.id=a.approver_id WHERE a.message_version_id=? ORDER BY a.id", [id]);
  return { message_version_id: id, version: v.version, is_latest: v.is_latest, lead_id: v.lead_id, content_hash: v.content_hash, authorizations: auths, decisions: v.decisions };
}

/** What the Owner decided on drafts (rejections with reasons, edits with old and new text), newest first. For agents to learn from. */
export async function listDecisions(actor: Actor, q: { lead_id?: number; limit?: number } = {}) {
  const scope = isManager(actor) ? "1=1" : "l.owner_id=?";
  const args: (string | number)[] = isManager(actor) ? [] : [actor.id];
  if (q.lead_id) { args.push(q.lead_id); }
  const rows = await all(
    `SELECT d.id,d.kind,d.reason,d.created_at,u.name AS decided_by,d.delegated,d.message_version_id,d.new_version_id,v.lead_id,l.company,v.version,v.subject,v.body,nv.subject AS new_subject,nv.body AS new_body
     FROM message_decisions d JOIN message_versions v ON v.id=d.message_version_id JOIN leads l ON l.id=v.lead_id JOIN users u ON u.id=d.decided_by
     LEFT JOIN message_versions nv ON nv.id=d.new_version_id
     WHERE ${scope}${q.lead_id ? " AND v.lead_id=?" : ""} ORDER BY d.id DESC LIMIT ${Math.min(Math.max(q.limit ?? 50, 1), 200)}`, args);
  return rows;
}

/** Approve several versions; each one stands alone (one failing does not stop the rest). */
export async function approveSends(actor: Actor, items: { message_version_id: number; permitted_action: string; note?: string }[]) {
  if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Only the Owner (or the delegated Chief) can approve sends.");
  if (!items.length) throw new HttpError(400, "items: nothing selected.");
  if (items.length > 100) throw new HttpError(400, "items: at most 100 at a time.");
  const results = [];
  for (const it of items) {
    try {
      const r = await authorize(actor, { message_version_id: it.message_version_id, kind: "send", permitted_action: it.permitted_action, note: it.note });
      results.push({ message_version_id: it.message_version_id, status: r.created ? "approved" : "already_approved", authorization_id: r.id });
    } catch (e) {
      results.push({ message_version_id: it.message_version_id, status: "error", error: (e as Error).message });
    }
  }
  return { approved: results.filter((r) => r.status === "approved").length, results };
}

/** Who approved what, when (the delegation audit view). */
export async function recentSendAuthorizations(actor: Actor, limit = 50) {
  if (!(await canAuthorizeSend(actor))) throw new HttpError(403, "Not allowed.");
  return all(
    `SELECT a.id,a.message_version_id,v.version,l.company,a.permitted_action,a.status,a.delegated,u.name AS approver,a.created_at
     FROM send_authorizations a JOIN message_versions v ON v.id=a.message_version_id JOIN leads l ON l.id=a.lead_id JOIN users u ON u.id=a.approver_id
     WHERE a.kind='send' ORDER BY a.id DESC LIMIT ?`, [limit]);
}

export async function revoke(actor: Actor, authId: number) {
  const a = await one("SELECT * FROM send_authorizations WHERE id=?", [authId]);
  if (!a) throw new HttpError(404, "Authorization not found.");
  if (a.kind === "send" ? !(await canAuthorizeSend(actor)) : !can(actor, "approvals.decide") && actor.role !== "owner") throw new HttpError(403, "You cannot revoke this authorization.");
  const r = await run("UPDATE send_authorizations SET status='revoked' WHERE id=? AND status='active'", [authId]);
  if (!r.changes) throw new HttpError(409, "Only an active authorization can be revoked.");
  await audit(actor, "revoke_authorization", "message_version", a.message_version_id as number, { authorization_id: authId });
  await syncTasks(actor, a.message_version_id as number);
}

/* ---------- eligibility ---------- */
export async function checkEligibility(actor: Actor, versionId: number) {
  const v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  await assertLeadAccess(actor, v.lead_id as number);
  const core = await eligibilityCore(v);
  const reasons = [...(!can(actor, "message.record_sent") ? ["you do not have message.record_sent, so this send could not be recorded"] : []), ...core.reasons];
  return { eligible: reasons.length === 0, reasons, codes: core.codes, warnings: core.warnings, authorization_id: core.authorization_id, message_version_id: versionId };
}

/**
 * The actor-independent eligibility rules, evaluated against data loaded ONCE for any number of versions
 * (a handful of queries in total, not a handful per version).
 */
type EligCtx = {
  latest: Map<number, number>; rejected: Map<number, string | null>; auths: Map<number, Row[]>;
  leads: Map<number, Row>; contacts: Map<number, Row[]>; camps: Map<number, Row>; members: Map<number, Row[]>;
  firstSent: Map<string, number>; activeSendByLead: Map<number, Row[]>; pendingByLead: Map<number, number>; recentByLead: Map<number, number>;
  senders: Map<number, Sender>; steps: Map<number, Step[]>; usedBySender: Map<number, number>; pushed: Map<number, number>;
  threadSenders: Map<number, { contact_id: number | null; sender_id: number }[]>; repliedLeads: Set<number>; today: string;
};
const groupBy = <T extends Row>(rows: T[], key: string) => { const m = new Map<number, T[]>(); for (const r of rows) { const k = r[key] as number; (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const inList = (ids: number[]) => ids.map(() => "?").join(",");

async function loadEligCtx(versions: Row[]): Promise<EligCtx> {
  const ids = [...new Set(versions.map((v) => v.id as number))];
  const leadIds = [...new Set(versions.map((v) => v.lead_id as number))];
  const campIds = [...new Set(versions.map((v) => v.campaign_id as number))];
  const empty = <T,>() => new Map<number, T>();
  if (!ids.length) return { latest: empty(), rejected: empty(), auths: empty(), leads: empty(), contacts: empty(), camps: empty(), members: empty(), firstSent: new Map(), activeSendByLead: empty(), pendingByLead: empty(), recentByLead: empty(), senders: empty(), steps: empty(), usedBySender: empty(), pushed: empty(), threadSenders: empty(), repliedLeads: new Set(), today: todayYmd() };
  const L = inList(leadIds);
  const today = todayYmd();
  const [threads, rej, auths, leads, contacts, camps, members, first, rival, pending, recent, cap, sl, thr, rep_] = await Promise.all([
    all(`SELECT id,lead_id,contact_id,channel,campaign_id,version FROM message_versions WHERE lead_id IN (${L})`, leadIds),
    all(`SELECT message_version_id,reason FROM message_decisions WHERE kind='rejected' AND message_version_id IN (${inList(ids)})`, ids),
    all(`SELECT * FROM send_authorizations WHERE message_version_id IN (${inList(ids)}) ORDER BY id`, ids),
    all(`SELECT * FROM leads WHERE id IN (${L})`, leadIds),
    all(`SELECT * FROM contacts WHERE lead_id IN (${L})`, leadIds),
    all(`SELECT id,status,name FROM campaigns WHERE id IN (${inList(campIds)})`, campIds),
    all(`SELECT lead_id,campaign_id FROM lead_campaigns WHERE status='active' AND lead_id IN (${L})`, leadIds),
    all(`SELECT lead_id,channel,COUNT(*) AS n FROM activities WHERE type='message' AND message_kind='first_email' AND is_demo=0 AND lead_id IN (${L}) GROUP BY lead_id,channel`, leadIds),
    all(`SELECT * FROM send_authorizations WHERE kind='send' AND status='active' AND lead_id IN (${L})`, leadIds),
    all(`SELECT lead_id,COUNT(*) AS n FROM send_events WHERE status='SENT_CONFIRMED_CRM_PENDING' AND lead_id IN (${L}) GROUP BY lead_id`, leadIds),
    all(`SELECT lead_id,COUNT(*) AS n FROM activities WHERE type='message' AND occurred_at>? AND lead_id IN (${L}) GROUP BY lead_id`, [new Date(Date.now() - 86400000).toISOString(), ...leadIds]),
    capacityData(today), loadSenders(),
    all(`SELECT DISTINCT lead_id, contact_id, COALESCE(sender_id,1) AS sender_id FROM activities WHERE type='message' AND outcome='sent' AND is_demo=0 AND lead_id IN (${L})`, leadIds),
    all(`SELECT DISTINCT lead_id FROM activities WHERE outcome='reply_received' AND is_demo=0 AND lead_id IN (${L})`, leadIds),
  ]);
  const latest = new Map<number, number>();
  const best = new Map<string, Row>();
  for (const th of threads) { const k = `${th.lead_id}|${th.contact_id ?? 0}|${th.channel}|${th.campaign_id}`; const b = best.get(k); if (!b || (th.version as number) > (b.version as number)) best.set(k, th); }
  for (const v of versions) { const b = best.get(`${v.lead_id}|${v.contact_id ?? 0}|${v.channel}|${v.campaign_id}`); latest.set(v.id as number, (b?.id as number) ?? (v.id as number)); }
  return {
    latest, rejected: new Map(rej.map((r) => [r.message_version_id as number, (r.reason as string) ?? null])), auths: groupBy(auths, "message_version_id"),
    leads: new Map(leads.map((l) => [l.id as number, l])), contacts: groupBy(contacts, "lead_id"), camps: new Map(camps.map((c) => [c.id as number, c])), members: groupBy(members, "lead_id"),
    firstSent: new Map(first.map((f) => [`${f.lead_id}|${f.channel}`, Number(f.n)])), activeSendByLead: groupBy(rival, "lead_id"),
    pendingByLead: new Map(pending.map((p) => [p.lead_id as number, Number(p.n)])), recentByLead: new Map(recent.map((p) => [p.lead_id as number, Number(p.n)])),
    senders: new Map(sl.senders.map((x) => [x.id, x])), steps: sl.steps,
    usedBySender: new Map(cap.senders.map((x) => [x.sender.id, x.used])),
    pushed: new Map(cap.senders.flatMap((x) => x.pushed.map((p) => [p.message_version_id, x.sender.id] as [number, number]))),
    threadSenders: new Map([...groupBy(thr, "lead_id")].map(([k, rows]) => [k, rows.map((r) => ({ contact_id: (r.contact_id as number) ?? null, sender_id: r.sender_id as number }))])),
    repliedLeads: new Set(rep_.map((r) => r.lead_id as number)), today,
  };
}

function evaluateEligibility(v: Row, c: EligCtx) {
  const versionId = v.id as number;
  const reasons: string[] = [];
  const codes: string[] = [];
  const warnings: string[] = [];
  const add = (code: string, text: string) => { codes.push(code); reasons.push(text); };
  if (c.latest.get(versionId) !== versionId) add("superseded", "a newer version of this message exists; authorization never carries over to edited text");
  if (c.rejected.has(versionId)) add("rejected", "the Owner rejected this draft (see decisions on the version); prepare a new version");
  const auth = [...(c.auths.get(versionId) ?? [])].reverse().find((a) => a.kind === "send" && a.status === "active");
  if (!auth) add("no_send_authorization", "no active Owner send authorization for this exact version, recipient, channel and campaign");
  const lead = c.leads.get(v.lead_id as number);
  const contacts = c.contacts.get(v.lead_id as number) ?? [];
  if (lead?.historical_only) add("historical_only", "the lead is historical-only and is not an outreach prospect");
  if (contacts.some((x) => x.email_status === "opted_out")) add("opted_out", "the lead has an opted-out contact (do not contact)");
  if (v.contact_id) {
    const ct = contacts.find((x) => x.id === v.contact_id);
    if (ct?.email_status === "bounced") add("bounced", "this contact's address bounced");
    if (ct?.is_invalid) add("contact_invalid", "this contact is marked invalid");
    if (v.channel === "email" && !ct?.email) add("no_email", "the recipient has no email address");
  }
  const camp = c.camps.get(v.campaign_id as number);
  if (camp?.status !== "active") add("campaign_not_active", `campaign "${camp?.name}" is ${camp?.status}, not active`);
  const mem = c.members.get(v.lead_id as number) ?? [];
  if (!mem.some((m) => m.campaign_id === v.campaign_id)) add("not_in_campaign", "the lead is not an active member of this campaign");
  else if (mem.length > 1) add("several_campaigns", "the lead is active in several campaigns; resolve with an explicit transfer first");
  if (auth?.permitted_action === "first_email" && (c.firstSent.get(`${v.lead_id}|${v.channel}`) ?? 0) > 0) add("first_email_already_sent", "a first email was already sent to this lead on this channel (any campaign, any date)");
  if ((c.activeSendByLead.get(v.lead_id as number) ?? []).some((a) => a.channel === v.channel && a.message_version_id !== versionId)) add("conflicting_authorization", "another active send authorization exists for this lead and channel (conflicting communication)");
  if ((c.pendingByLead.get(v.lead_id as number) ?? 0) > 0) add("crm_pending", "a previous send to this lead is SENT_CONFIRMED_CRM_PENDING; reconcile it before anything else");
  // sender rules
  const sender = c.senders.get((v.sender_id as number) ?? 1);
  if (!sender) add("sender_inactive", "this version has no valid sender");
  else {
    const who = `${sender.display_name} <${sender.email}>`;
    if (!sender.active) add("sender_inactive", `sender ${who} is switched off`);
    const lang = (v.language as string) || detectLanguage(`${v.subject ?? ""} ${v.body}`);
    if (!sender.languages.includes(lang)) add("sender_language_mismatch", `this message is in "${lang}" but ${who} only sends ${sender.languages.join("/")}`);
    if (sender.campaign_ids && !sender.campaign_ids.includes(v.campaign_id as number)) add("sender_campaign_not_allowed", `${who} is not allowed to send for campaign "${camp?.name}"`);
    const prior = (c.threadSenders.get(v.lead_id as number) ?? []).filter((t) => !v.contact_id || t.contact_id == null || t.contact_id === v.contact_id);
    const other = prior.find((t) => t.sender_id !== sender.id);
    if (other) add("sender_thread_mismatch", `this lead/contact was already written to from ${c.senders.get(other.sender_id)?.email ?? `sender ${other.sender_id}`}; follow-ups must come from the same sender so the thread does not split`);
    if (sender.paused_at && (auth?.permitted_action === "first_email" || (auth?.permitted_action === "follow_up" && !c.repliedLeads.has(v.lead_id as number)) || !auth))
      add("sender_paused_deliverability", `${who} is paused (${sender.pause_kind === "auto" ? "automatic deliverability guard" : "by the Owner"}): ${sender.pause_reason ?? "no reason given"}; the Owner must resume it`);
    const cp = capOn(sender, c.steps.get(sender.id), c.today);
    const used = c.usedBySender.get(sender.id) ?? 0;
    if (cp.cap !== null && used >= cp.cap) add("daily_cap_reached", cp.not_started ? `${who} has not started warming up yet (first day is ${c.steps.get(sender.id)?.[0]?.from_date}); cap is 0 until then` : `daily send cap reached for ${who}: ${used} of ${cp.cap} messages already sent today (Asia/Hebron); it can go out on the next send slot`);
    else if (c.pushed.has(versionId)) add("daily_cap_reached", `${who}'s remaining capacity today (${cp.cap === null ? "-" : Math.max(0, cp.cap - used)}) is taken by higher-priority campaigns; this send is pushed to the next day`);
  }
  if ((c.recentByLead.get(v.lead_id as number) ?? 0) > 0) warnings.push("a message to this lead was recorded in the last 24 hours");
  return { reasons, codes, warnings, authorization_id: (auth?.id as number) ?? null };
}

async function eligibilityCore(v: Row) {
  return evaluateEligibility(v, await loadEligCtx([v]));
}

/* ---------- task <-> message version: live readiness and automatic status ---------- */
/** A draft-preparation task closes when its draft is approved; every other open outreach task is a "send" task. */
export const isPrepTask = (t: Row) => /draft/i.test(String(t.action_type ?? ""));
const NON_SEND = /prepar|draft|research|validat|review/i;

export type Readiness = { state: "ready" | "blocked" | "sent"; prep_status: string | null; blockers: string | null; label: string | null; version_id: number };

/** The real state of message versions, computed from approvals and the eligibility rules (batched: few queries for any number of versions). */
export async function readinessMany(versionIds: number[]): Promise<Map<number, Readiness>> {
  const out = new Map<number, Readiness>();
  const uniq = [...new Set(versionIds)];
  if (!uniq.length) return out;
  // The latest version of each requested message, in ONE query.
  const pairs = await all(
    `SELECT b.id AS base_id, l.* FROM message_versions b JOIN message_versions l ON l.id = (
       SELECT v2.id FROM message_versions v2 WHERE v2.lead_id=b.lead_id AND COALESCE(v2.contact_id,0)=COALESCE(b.contact_id,0) AND v2.channel=b.channel AND v2.campaign_id=b.campaign_id ORDER BY v2.version DESC, v2.id DESC LIMIT 1)
     WHERE b.id IN (${inList(uniq)})`, uniq);
  const latestOf = new Map<number, number>(pairs.map((p) => [p.base_id as number, p.id as number]));
  const latestRows = [...new Map(pairs.map((p) => [p.id as number, p as Row])).values()];
  const ctx = await loadEligCtx(latestRows);
  const lastFor = new Map<number, Readiness>();
  for (const v of latestRows) {
    const id = v.id as number;
    const as = ctx.auths.get(id) ?? [];
    const blocked = (prep: string, why: string): Readiness => ({ state: "blocked", prep_status: prep, blockers: why, label: null, version_id: id });
    let r: Readiness;
    if (as.some((a) => a.kind === "send" && a.status === "used")) r = { state: "sent", prep_status: null, blockers: null, label: "Sent", version_id: id };
    else if (ctx.rejected.has(id)) r = blocked("draft_needed", `Draft rejected by the Owner: ${ctx.rejected.get(id)}. Prepare a new version.`);
    else if (!as.some((a) => a.kind === "editorial" && a.status === "active")) r = blocked("internal_review", `Waiting for the Chief's editorial review of version #${id}.`);
    else {
      const core = evaluateEligibility(v, ctx);
      if (!core.authorization_id) r = blocked("user_approval_needed", `Waiting for the Owner's send approval of version #${id}.`);
      else if (core.reasons.length) r = blocked("validation_needed", `Approved, but not sendable: ${core.reasons.join("; ")}.`);
      else r = { state: "ready", prep_status: "ready_for_execution", blockers: null, label: "Approved, ready to send", version_id: id };
    }
    lastFor.set(id, r);
  }
  for (const [baseId, lid] of latestOf) out.set(baseId, lastFor.get(lid)!);
  return out;
}
export async function readiness(versionId: number): Promise<Readiness> {
  const r = (await readinessMany([versionId])).get(versionId);
  if (!r) throw new HttpError(404, "Message version not found.");
  return r;
}

/** Finds (and links) the open send task(s) of this message's thread, pointing them at the latest version. */
async function linkSendTasks(v: Row): Promise<Row[]> {
  const thread = (await all("SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=?", [v.lead_id as number, (v.contact_id as number) ?? 0, v.channel as string, v.campaign_id as number])).map((r) => r.id as number);
  const open = await all("SELECT * FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND is_demo=(SELECT is_demo FROM leads WHERE id=?)", [v.lead_id as number, v.lead_id as number]);
  let linked = open.filter((t) => !isPrepTask(t) && ((t.message_version_id && thread.includes(t.message_version_id as number)) || t.id === v.task_id));
  if (!linked.length) {
    // No explicit link: adopt the one open outreach task for this lead, channel and campaign (never guess between several).
    const cand = open.filter((t) => !NON_SEND.test(String(t.action_type ?? t.title ?? "")) && !t.message_version_id && (!t.channel || t.channel === v.channel) && (!t.campaign_id || t.campaign_id === v.campaign_id) && (t.action_type || t.channel));
    if (cand.length === 1) linked = cand;
  }
  for (const t of linked) if (t.message_version_id !== v.id) await run("UPDATE tasks SET message_version_id=? WHERE id=?", [v.id as number, t.id as number]);
  return linked;
}

/** Closes the open draft-preparation task(s) of this message once the draft has BOTH approvals (or has been sent). */
export async function closePrepTasks(actor: Actor, v: Row, why: string) {
  const id = v.id as number;
  const has = async (kind: string) => !!(await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind=? AND status IN ('active','used')", [id, kind]));
  const sent = !!(await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='used'", [id]));
  if (!sent && !((await has("editorial")) && (await has("send")))) return 0;
  const preps = await all("SELECT * FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND action_type LIKE '%draft%' COLLATE NOCASE AND (id=? OR ((channel IS NULL OR channel=?) AND (campaign_id IS NULL OR campaign_id=?)))", [v.lead_id as number, (v.task_id as number) ?? 0, v.channel as string, v.campaign_id as number]);
  for (const t of preps) {
    const ts = now();
    const note = `Auto-closed: ${why} (version #${id})`;
    await run("UPDATE tasks SET status='completed', completed_at=?, completed_by=?, completion_note=?, message_version_id=COALESCE(message_version_id,?), blockers=NULL, updated_at=? WHERE id=?", [ts, actor.id, note, id, ts, t.id as number]);
    await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [t.lead_id as number, t.id as number, `Task completed: ${t.title}`, note, actor.id, ts, ts, t.is_demo as number]);
    await audit(actor, "task_auto_complete", "task", t.id as number, { reason: why, message_version_id: id });
  }
  return preps.length;
}

/**
 * Owner/Chief: bring every task in line with the approvals and sends that already exist (stored blockers, draft-prep tasks that should have closed).
 * Idempotent. Never completes a send task by itself: those are listed for you to close with a proving activity.
 */
export async function reconcileTasks(actor: Actor) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or a Chief can reconcile tasks.");
  const versions = await all(`SELECT v.id FROM message_versions v JOIN leads l ON l.id=v.lead_id WHERE l.is_demo=0 AND ${LATEST}`);
  let prepClosed = 0;
  for (const v of versions) {
    const before = Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE status='completed' AND completion_note LIKE 'Auto-closed:%'"))!.n);
    await syncTasks(actor, v.id as number);
    prepClosed += Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE status='completed' AND completion_note LIKE 'Auto-closed:%'"))!.n) - before;
  }
  const sentOpen = await all("SELECT t.id,t.title,t.lead_id,t.message_version_id,e.activity_id FROM tasks t JOIN send_authorizations a ON a.message_version_id=t.message_version_id AND a.kind='send' AND a.status='used' LEFT JOIN send_events e ON e.id=a.send_event_id WHERE t.status NOT IN ('completed','cancelled')");
  await audit(actor, "reconcile_tasks", "task", null, { versions: versions.length, prep_closed: prepClosed });
  return { versions_checked: versions.length, prep_tasks_closed: prepClosed, sent_but_task_open: sentOpen };
}

/** Keeps stored task fields in line with the real approval state, and closes the draft-preparation task once its draft is approved. */
export async function syncTasks(actor: Actor, versionId: number) {
  try {
    const base = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
    if (!base) return;
    const v = (await one("SELECT * FROM message_versions WHERE id=?", [await latestVersion(base)]))!;
    const linked = await linkSendTasks(v);
    const r = await readiness(v.id as number);
    if (r.state !== "sent") for (const t of linked) {
      const blockers = r.blockers;
      if ((t.prep_status ?? null) === r.prep_status && (t.blockers ?? null) === blockers) continue;
      await run("UPDATE tasks SET prep_status=?, blockers=?, updated_at=? WHERE id=?", [r.prep_status, blockers, now(), t.id as number]);
      await audit(actor, "task_auto_status", "task", t.id as number, { message_version_id: v.id, from: { prep_status: t.prep_status, blockers: t.blockers }, to: { prep_status: r.prep_status, blockers } });
    }
    // draft approved (editorial + send, still active or already used by a send) -> the preparation task closes by itself
    await closePrepTasks(actor, v, "draft approved");
  } catch (e) {
    console.error("task sync failed", e);
  }
}

/* ---------- confirm + record ---------- */
const confirmSchema = z.object({ event_id: z.string().trim().min(3).max(120), message_version_id: z.coerce.number().int(), sent_at: z.string().min(8), evidence: z.string().trim().min(3, "required: mailbox message-id, link or screenshot reference").max(2000) });

async function findEvent(eventId: string): Promise<Row | null> {
  const e = await one("SELECT * FROM send_events WHERE event_id=?", [eventId]);
  return e ? ({ ...e, stop_further_sends: e.status === "SENT_CONFIRMED_CRM_PENDING" } as Row) : null;
}
async function sendEventView(eventId: string): Promise<Row> {
  const e = await findEvent(eventId);
  if (!e) throw new HttpError(404, "Send event not found.");
  return e;
}

export async function confirmSend(actor: Actor, input: unknown) {
  requirePerm(actor, "message.record_sent");
  const d = parse(confirmSchema, input);
  const existing = await findEvent(d.event_id);
  if (existing) {
    if (existing.message_version_id !== d.message_version_id) throw new HttpError(409, "event_id was already used for a different message.");
    return { ...existing, duplicate: true };
  }
  const ev = parseEventDate(d.sent_at);
  if (typeof ev === "string") throw new HttpError(400, dateProblem(ev, "sent_at"));
  if (ev.precision !== "time" || !ev.at) throw new HttpError(400, "sent_at: a send needs an exact time (ISO with Z or an offset).");
  if (new Date(ev.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, "sent_at: cannot be in the future.");
  const v = await one("SELECT * FROM message_versions WHERE id=?", [d.message_version_id]);
  if (!v) throw new HttpError(400, "message_version_id: unknown version.");
  await assertLeadAccess(actor, v.lead_id as number);
  const el = await checkEligibility(actor, d.message_version_id);
  if (!el.eligible) { const e = new HttpError(409, `Not sent-eligible: ${el.reasons.join("; ")}.`); throw e; }
  // Atomic claim: only one worker can ever consume an authorization.
  const claim = await run("UPDATE send_authorizations SET status='used', used_at=? WHERE id=? AND status='active'", [now(), el.authorization_id]);
  if (!claim.changes) {
    const taken = await one("SELECT e.event_id FROM send_events e WHERE e.authorization_id=?", [el.authorization_id]);
    if (taken?.event_id === d.event_id) return { ...(await sendEventView(d.event_id)), duplicate: true };
    throw new HttpError(409, "That authorization was already used by another send. Nothing was recorded.");
  }
  const t = now();
  try {
    await run("INSERT INTO send_events (event_id,message_version_id,authorization_id,lead_id,contact_id,channel,campaign_id,status,sent_at,evidence,reported_by,created_at,updated_at,sender_id) VALUES (?,?,?,?,?,?,?,'SENT_CONFIRMED_CRM_PENDING',?,?,?,?,?,?)",
      [d.event_id, d.message_version_id, el.authorization_id, v.lead_id as number, (v.contact_id as number) ?? null, v.channel as string, v.campaign_id as number, ev.at, d.evidence, actor.id, t, t, (v.sender_id as number) ?? 1]);
  } catch (e) {
    const dup = await findEvent(d.event_id);
    if (dup) return { ...dup, duplicate: true };
    throw e;
  }
  await run("UPDATE send_authorizations SET send_event_id=(SELECT id FROM send_events WHERE event_id=?) WHERE id=?", [d.event_id, el.authorization_id]);
  await audit(actor, "confirm_send", "message_version", d.message_version_id, { event_id: d.event_id, authorization_id: el.authorization_id });
  return recordEvent(actor, d.event_id);
}

/** Records the communication exactly once (keyed on the event id), reads it back, then updates the lead. Never resends. */
async function recordEvent(actor: Actor, eventId: string) {
  const e = (await one("SELECT * FROM send_events WHERE event_id=?", [eventId]))!;
  if (e.status === "RECORDED") return { ...(await sendEventView(eventId)), duplicate: true };
  try {
    if (testHooks.failRecording > 0) { testHooks.failRecording--; throw new Error("simulated CRM outage"); }
    const v = (await one("SELECT * FROM message_versions WHERE id=?", [e.message_version_id as number]))!;
    const auth = (await one("SELECT permitted_action FROM send_authorizations WHERE id=?", [e.authorization_id as number]))!;
    const lead = (await one("SELECT * FROM leads WHERE id=?", [e.lead_id as number]))!;
    let act = await one("SELECT id FROM activities WHERE external_id=?", [eventId]);
    const t = now();
    if (!act) {
      const r = await run(
        `INSERT INTO activities (lead_id,contact_id,task_id,type,message_kind,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,sender_id)
         VALUES (?,?,?,'message',?,?,'sent',?,?,?,?,?,?,?,'time',?,?)`,
        [lead.id as number, (e.contact_id as number) ?? null, (v.task_id as number) ?? null, auth.permitted_action as string, e.channel as string, v.subject as string | null, v.body as string, `send-event:${eventId}`, e.reported_by as number, e.sent_at as string, t, lead.is_demo as number, eventId, (e.sender_id as number) ?? 1]);
      act = { id: r.id };
    }
    // read back what was stored and verify it matches the confirmed send
    const back = await one("SELECT * FROM activities WHERE id=?", [act.id as number]);
    const good = back && back.lead_id === e.lead_id && back.type === "message" && back.outcome === "sent" && back.channel === e.channel && back.occurred_at === e.sent_at && back.body === v.body && (back.contact_id ?? null) === (e.contact_id ?? null);
    if (!good) throw new Error("read-back mismatch: the stored activity differs from the confirmed send");
    const stmts: { sql: string; args: (string | number | null)[] }[] = [
      { sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?", args: [e.sent_at as string, e.sent_at as string, t, lead.id as number] },
    ];
    // Stage: only an automatic move out of the pre-contact stages, never over a stronger stage or a restriction.
    if (PRE_CONTACT_STAGES.includes(lead.stage as string) && (await one("SELECT key FROM lists WHERE kind='stage' AND key='contacted' AND active=1"))) {
      stmts.push({ sql: "UPDATE leads SET stage='contacted' WHERE id=?", args: [lead.id as number] });
      stmts.push({ sql: "INSERT INTO activities (lead_id,type,title,body,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo) VALUES (?,'status','Stage changed','Message sent (confirmed send event)',?,'contacted',?,?,?,?)", args: [lead.id as number, lead.stage as string, e.reported_by as number, t, t, lead.is_demo as number] });
    }
    // The linked send task completes by itself, whoever it is assigned to.
    const doneTasks = (await all("SELECT id,title,action_type,lead_id,is_demo FROM tasks WHERE status NOT IN ('completed','cancelled') AND (message_version_id=? OR id=?)", [v.id as number, (v.task_id as number) ?? 0])).filter((x) => !isPrepTask(x));
    for (const tk of doneTasks) {
      stmts.push({ sql: "UPDATE tasks SET status='completed', completed_at=?, completed_by=?, completion_note=?, activity_id=?, sent_at=?, blockers=NULL, message_version_id=?, updated_at=? WHERE id=?", args: [t, e.reported_by as number, `Auto-completed: send recorded (event ${eventId}, activity ${act.id})`, act.id as number, e.sent_at as string, v.id as number, t, tk.id as number] });
      stmts.push({ sql: "UPDATE activities SET task_id=? WHERE id=? AND task_id IS NULL", args: [tk.id as number, act.id as number] });
      stmts.push({ sql: "INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", args: [tk.lead_id as number, tk.id as number, `Task completed: ${tk.title}`, `Auto-completed when the send was recorded (activity ${act.id})`, e.reported_by as number, t, t, tk.is_demo as number] });
      stmts.push({ sql: "INSERT INTO audit_log (actor_id,actor_name,via,action,entity,entity_id,detail,created_at) SELECT id,name,'system','task_auto_complete','task',?,?,? FROM users WHERE id=?", args: [String(tk.id), JSON.stringify({ event_id: eventId, activity_id: act.id, message_version_id: v.id }), t, e.reported_by as number] });
    }
    stmts.push({ sql: "UPDATE send_events SET status='RECORDED', activity_id=?, last_error=NULL, updated_at=? WHERE event_id=? AND status<>'RECORDED'", args: [act.id as number, t, eventId] });
    await tx(stmts);
  } catch (err) {
    await run("UPDATE send_events SET last_error=?, updated_at=? WHERE event_id=?", [(err as Error).message.slice(0, 500), now(), eventId]);
    await audit(actor, "send_recording_failed", "send_event", e.id as number, { event_id: eventId, error: (err as Error).message });
    return { ...(await sendEventView(eventId)), message: "The message was sent but the CRM record is pending. Do NOT resend. Stop sending in this run and POST /sends/{event_id}/reconcile." };
  }
  await audit(actor, "record_send", "send_event", e.id as number, { event_id: eventId });
  try { const sv = await one("SELECT * FROM message_versions WHERE id=?", [e.message_version_id as number]); if (sv) await closePrepTasks(actor, sv, "send recorded"); } catch (err) { console.error("prep close failed", err); }
  return sendEventView(eventId);
}

export async function reconcileSend(actor: Actor, eventId: string) {
  if (!can(actor, "message.record_sent") && !isManager(actor)) throw new HttpError(403, "You cannot reconcile sends.");
  const e = await one("SELECT lead_id FROM send_events WHERE event_id=?", [eventId]);
  if (!e) throw new HttpError(404, "Send event not found.");
  await assertLeadAccess(actor, e.lead_id as number);
  return recordEvent(actor, eventId);
}

export async function listSends(actor: Actor, status?: string) {
  const sc = can(actor, "leads.view_all") ? "1=1" : "e.reported_by=?";
  return all(
    `SELECT e.event_id,e.status,e.lead_id,l.company,e.contact_id,e.channel,e.campaign_id,e.message_version_id,e.sent_at,e.activity_id,e.last_error,e.created_at,u.name AS reported_by_name
     FROM send_events e JOIN leads l ON l.id=e.lead_id JOIN users u ON u.id=e.reported_by
     WHERE ${sc}${status ? " AND e.status=?" : ""} ORDER BY e.id DESC LIMIT 200`, [...(can(actor, "leads.view_all") ? [] : [actor.id]), ...(status ? [status] : [])]);
}
