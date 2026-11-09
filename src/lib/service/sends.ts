import { z } from "zod";
import { createHash } from "node:crypto";
import { all, one, run, tx, now, type Row } from "../db";
import { HttpError, can, isManager, requirePerm, type Actor } from "../auth";
import { audit, parse, optText, optInt, parseEventDate, dateProblem } from "./common";
import { assertLeadAccess } from "./leads";
import { assertChannel } from "./campaigns";

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
  const d = parse(z.object({ lead_id: z.coerce.number().int(), contact_id: optInt.optional(), channel: z.string().min(1), campaign_id: z.coerce.number().int(), task_id: optInt.optional(), subject: optText(300).optional(), body: z.string().trim().min(1, "required").max(20000) }), input);
  const lead = await assertLeadAccess(actor, d.lead_id);
  await assertChannel(d.channel);
  if (!(await one("SELECT id FROM campaigns WHERE id=?", [d.campaign_id]))) throw new HttpError(400, "campaign_id: unknown campaign.");
  if (d.contact_id && !(await one("SELECT id FROM contacts WHERE id=? AND lead_id=?", [d.contact_id, d.lead_id]))) throw new HttpError(400, "contact_id: not a contact of this lead.");
  const subject = d.subject ?? null;
  const prev = await one("SELECT id,version,content_hash FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? ORDER BY version DESC LIMIT 1", [d.lead_id, d.contact_id ?? 0, d.channel, d.campaign_id]);
  const h = hash(subject, d.body);
  if (prev && prev.content_hash === h) return { id: prev.id as number, version: prev.version as number, created: false };
  const version = ((prev?.version as number) ?? 0) + 1;
  if (d.task_id == null && prev) { const pt = await one("SELECT task_id FROM message_versions WHERE id=?", [prev.id as number]); if (pt?.task_id) d.task_id = pt.task_id as number; }
  const r = await run("INSERT INTO message_versions (lead_id,contact_id,channel,campaign_id,task_id,version,subject,body,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [d.lead_id, d.contact_id ?? null, d.channel, d.campaign_id, d.task_id ?? null, version, subject, d.body, h, actor.id, now()]);
  // An edit voids every still-active authorization of the earlier versions of this thread.
  const voided = await run("UPDATE send_authorizations SET status='revoked' WHERE status='active' AND message_version_id IN (SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? AND id<>?)", [d.lead_id, d.contact_id ?? 0, d.channel, d.campaign_id, r.id]);
  await audit(actor, "create_message_version", "message_version", r.id, { lead_id: d.lead_id, version, revoked_authorizations: voided.changes, is_test: !!lead.is_demo });
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
  return { ...v, is_latest: latest === v.id, authorizations: auths, decisions } as Row & { is_latest: boolean; authorizations: Row[]; decisions: Row[] };
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
    `SELECT v.id,v.version,v.lead_id,v.contact_id,v.channel,v.campaign_id,v.task_id,v.subject,v.body,v.created_at,l.company,c.name AS campaign,
            ct.name AS recipient_name,ct.email AS recipient_email,u.name AS prepared_by,t.action_type
     FROM message_versions v JOIN leads l ON l.id=v.lead_id JOIN campaigns c ON c.id=v.campaign_id JOIN users u ON u.id=v.created_by
     LEFT JOIN contacts ct ON ct.id=v.contact_id LEFT JOIN tasks t ON t.id=v.task_id
     WHERE ${WAITING} ORDER BY v.created_at, v.id LIMIT 200`);
  const out: Row[] = [];
  for (const v of rows) {
    const ed = await one("SELECT a.created_at,u.name FROM send_authorizations a JOIN users u ON u.id=a.approver_id WHERE a.message_version_id=? AND a.kind='editorial' AND a.status='active' ORDER BY a.id DESC LIMIT 1", [v.id as number]);
    const prior = await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message' AND message_kind='first_email' AND channel=? AND is_demo=0", [v.lead_id as number, v.channel as string]);
    const el = await checkEligibility(actor, v.id as number).catch(() => ({ reasons: [] as string[], warnings: [] as string[] }));
    out.push({
      ...v,
      editorial_status: ed ? `Reviewed by ${ed.name}` : "Not yet reviewed",
      editorial_reviewed: !!ed,
      suggested_action: suggestAction(v.action_type as string | null, Number(prior!.n)),
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
  const d = parse(z.object({ subject: optText(300).optional(), body: z.string().trim().min(1, "required").max(20000), note: optText(2000).optional() }), input);
  const v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  if ((await latestVersion(v)) !== v.id) throw new HttpError(409, "A newer version exists; edit that one.");
  if (await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='used'", [versionId])) throw new HttpError(409, "This version was already sent and cannot be edited.");
  const r = await createVersion(actor, { lead_id: v.lead_id, contact_id: v.contact_id, channel: v.channel, campaign_id: v.campaign_id, task_id: v.task_id, subject: d.subject ?? v.subject, body: d.body });
  if (!r.created) throw new HttpError(400, "Nothing changed: the text is identical to this version.");
  await run("INSERT INTO message_decisions (message_version_id,kind,reason,new_version_id,decided_by,delegated,created_at) VALUES (?,?,?,?,?,?,?)", [versionId, "edited", d.note ?? null, r.id, actor.id, actor.role !== "owner" ? 1 : 0, now()]);
  await audit(actor, "edit_message_version", "message_version", versionId, { lead_id: v.lead_id, new_version_id: r.id, note: d.note ?? null });
  return { old_version_id: versionId, new_version_id: r.id, version: r.version };
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
  return { eligible: reasons.length === 0, reasons, warnings: core.warnings, authorization_id: core.authorization_id, message_version_id: versionId };
}

/** The actor-independent rules. Used by the eligibility check, and by the task status sync (which has no actor). */
async function eligibilityCore(v: Row) {
  const versionId = v.id as number;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if ((await latestVersion(v)) !== v.id) reasons.push("a newer version of this message exists; authorization never carries over to edited text");
  if (await one("SELECT 1 AS x FROM message_decisions WHERE message_version_id=? AND kind='rejected'", [versionId])) reasons.push("the Owner rejected this draft (see decisions on the version); prepare a new version");
  const auth = await one("SELECT * FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='active' ORDER BY id DESC LIMIT 1", [versionId]);
  if (!auth) reasons.push("no active Owner send authorization for this exact version, recipient, channel and campaign");
  const lead = await one("SELECT * FROM leads WHERE id=?", [v.lead_id as number]);
  if (lead?.historical_only) reasons.push("the lead is historical-only and is not an outreach prospect");
  const bad = await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=? AND email_status='opted_out'", [v.lead_id as number]);
  if (Number(bad!.n) > 0) reasons.push("the lead has an opted-out contact (do not contact)");
  if (v.contact_id) {
    const c = await one("SELECT * FROM contacts WHERE id=?", [v.contact_id as number]);
    if (c?.email_status === "bounced") reasons.push("this contact's address bounced");
    if (v.channel === "email" && !c?.email) reasons.push("the recipient has no email address");
  }
  const camp = await one("SELECT status,name FROM campaigns WHERE id=?", [v.campaign_id as number]);
  if (camp?.status !== "active") reasons.push(`campaign "${camp?.name}" is ${camp?.status}, not active`);
  const mem = await all("SELECT campaign_id FROM lead_campaigns WHERE lead_id=? AND status='active'", [v.lead_id as number]);
  if (!mem.some((m) => m.campaign_id === v.campaign_id)) reasons.push("the lead is not an active member of this campaign");
  else if (mem.length > 1) reasons.push("the lead is active in several campaigns; resolve with an explicit transfer first");
  if (auth?.permitted_action === "first_email") {
    const prior = await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message' AND message_kind='first_email' AND channel=? AND is_demo=0", [v.lead_id as number, v.channel as string]);
    if (Number(prior!.n) > 0) reasons.push("a first email was already sent to this lead on this channel (any campaign, any date)");
  }
  const rival = await one("SELECT COUNT(*) AS n FROM send_authorizations a WHERE a.kind='send' AND a.status='active' AND a.lead_id=? AND a.channel=? AND a.message_version_id<>?", [v.lead_id as number, v.channel as string, versionId]);
  if (Number(rival!.n) > 0) reasons.push("another active send authorization exists for this lead and channel (conflicting communication)");
  const pending = await one("SELECT COUNT(*) AS n FROM send_events WHERE lead_id=? AND status='SENT_CONFIRMED_CRM_PENDING'", [v.lead_id as number]);
  if (Number(pending!.n) > 0) reasons.push("a previous send to this lead is SENT_CONFIRMED_CRM_PENDING; reconcile it before anything else");
  const recent = await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message' AND occurred_at>?", [v.lead_id as number, new Date(Date.now() - 86400000).toISOString()]);
  if (Number(recent!.n) > 0) warnings.push("a message to this lead was recorded in the last 24 hours");
  return { reasons, warnings, authorization_id: (auth?.id as number) ?? null };
}


/* ---------- task <-> message version: live readiness and automatic status ---------- */
/** A draft-preparation task closes when its draft is approved; every other open outreach task is a "send" task. */
export const isPrepTask = (t: Row) => /draft/i.test(String(t.action_type ?? ""));
const NON_SEND = /prepar|draft|research|validat|review/i;

export type Readiness = { state: "ready" | "blocked" | "sent"; prep_status: string | null; blockers: string | null; label: string | null; version_id: number };

/** The real state of a message version, computed from approvals and the eligibility rules. Never stored text. */
export async function readiness(versionId: number): Promise<Readiness> {
  let v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  v = (await one("SELECT * FROM message_versions WHERE id=?", [await latestVersion(v)]))!;
  const id = v.id as number;
  const blocked = (prep: string, why: string): Readiness => ({ state: "blocked", prep_status: prep, blockers: why, label: null, version_id: id });
  if (await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='send' AND status='used'", [id])) return { state: "sent", prep_status: null, blockers: null, label: "Sent", version_id: id };
  const rej = await one("SELECT reason FROM message_decisions WHERE message_version_id=? AND kind='rejected'", [id]);
  if (rej) return blocked("draft_needed", `Draft rejected by the Owner: ${rej.reason}. Prepare a new version.`);
  if (!(await one("SELECT 1 AS x FROM send_authorizations WHERE message_version_id=? AND kind='editorial' AND status='active'", [id]))) return blocked("internal_review", `Waiting for the Chief's editorial review of version #${id}.`);
  const core = await eligibilityCore(v);
  if (!core.authorization_id) return blocked("user_approval_needed", `Waiting for the Owner's send approval of version #${id}.`);
  if (core.reasons.length) return blocked("validation_needed", `Approved, but not sendable: ${core.reasons.join("; ")}.`);
  return { state: "ready", prep_status: "ready_for_execution", blockers: null, label: "Approved, ready to send", version_id: id };
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
    // draft approved (editorial + send) -> the preparation task closes by itself
    const approved = r.state === "ready" || (r.state === "blocked" && r.prep_status === "validation_needed");
    if (approved) {
      const preps = await all("SELECT * FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND (action_type LIKE '%draft%' COLLATE NOCASE) AND (channel IS NULL OR channel=?) AND (campaign_id IS NULL OR campaign_id=?)", [v.lead_id as number, v.channel as string, v.campaign_id as number]);
      for (const t of preps) {
        const ts = now();
        await run("UPDATE tasks SET status='completed', completed_at=?, completed_by=?, completion_note=?, message_version_id=?, blockers=NULL, updated_at=? WHERE id=?", [ts, actor.id, `Auto-closed: draft version #${v.id} was approved`, v.id as number, ts, t.id as number]);
        await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [t.lead_id as number, t.id as number, `Task completed: ${t.title}`, `Auto-closed: draft version #${v.id} was approved`, actor.id, ts, ts, t.is_demo as number]);
        await audit(actor, "task_auto_complete", "task", t.id as number, { reason: "draft approved", message_version_id: v.id });
      }
    }
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
    await run("INSERT INTO send_events (event_id,message_version_id,authorization_id,lead_id,contact_id,channel,campaign_id,status,sent_at,evidence,reported_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'SENT_CONFIRMED_CRM_PENDING',?,?,?,?,?)",
      [d.event_id, d.message_version_id, el.authorization_id, v.lead_id as number, (v.contact_id as number) ?? null, v.channel as string, v.campaign_id as number, ev.at, d.evidence, actor.id, t, t]);
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
        `INSERT INTO activities (lead_id,contact_id,task_id,type,message_kind,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id)
         VALUES (?,?,?,'message',?,?,'sent',?,?,?,?,?,?,?,'time',?)`,
        [lead.id as number, (e.contact_id as number) ?? null, (v.task_id as number) ?? null, auth.permitted_action as string, e.channel as string, v.subject as string | null, v.body as string, `send-event:${eventId}`, e.reported_by as number, e.sent_at as string, t, lead.is_demo as number, eventId]);
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
