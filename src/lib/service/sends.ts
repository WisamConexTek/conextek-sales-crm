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
  const r = await run("INSERT INTO message_versions (lead_id,contact_id,channel,campaign_id,task_id,version,subject,body,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [d.lead_id, d.contact_id ?? null, d.channel, d.campaign_id, d.task_id ?? null, version, subject, d.body, h, actor.id, now()]);
  // An edit voids every still-active authorization of the earlier versions of this thread.
  const voided = await run("UPDATE send_authorizations SET status='revoked' WHERE status='active' AND message_version_id IN (SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? AND id<>?)", [d.lead_id, d.contact_id ?? 0, d.channel, d.campaign_id, r.id]);
  await audit(actor, "create_message_version", "message_version", r.id, { lead_id: d.lead_id, version, revoked_authorizations: voided.changes, is_test: !!lead.is_demo });
  return { id: r.id, version, created: true };
}

export async function getVersion(actor: Actor, id: number) {
  const v = await one("SELECT * FROM message_versions WHERE id=?", [id]);
  if (!v) throw new HttpError(404, "Message version not found.");
  await assertLeadAccess(actor, v.lead_id as number);
  const latest = await latestVersion(v);
  const auths = await all("SELECT a.id,a.kind,a.permitted_action,a.status,a.approver_id,u.name AS approver_name,a.note,a.created_at,a.used_at FROM send_authorizations a JOIN users u ON u.id=a.approver_id WHERE a.message_version_id=? ORDER BY a.id", [id]);
  return { ...v, is_latest: latest === v.id, authorizations: auths };
}
async function latestVersion(v: Row) {
  const r = await one("SELECT id FROM message_versions WHERE lead_id=? AND COALESCE(contact_id,0)=? AND channel=? AND campaign_id=? ORDER BY version DESC LIMIT 1", [v.lead_id, v.contact_id ?? 0, v.channel, v.campaign_id]);
  return r!.id as number;
}

/* ---------- authorizations ---------- */
export async function authorize(actor: Actor, input: unknown) {
  const d = parse(z.object({ message_version_id: z.coerce.number().int(), kind: z.enum(["editorial", "send"]), permitted_action: z.enum(ACTIONS), note: optText(500).optional() }), input);
  if (d.kind === "send") { if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can authorize a send. A Chief's editorial approval is not permission to send."); }
  else if (!can(actor, "approvals.decide") && actor.role !== "owner") throw new HttpError(403, "Editorial approval needs approvals.decide (Chief or Owner).");
  const v = await one("SELECT * FROM message_versions WHERE id=?", [d.message_version_id]);
  if (!v) throw new HttpError(400, "message_version_id: unknown version.");
  if ((await latestVersion(v)) !== v.id) throw new HttpError(409, "That is not the latest version of this message. Review the newest version; authorization never carries over to edited text.");
  const same = await one("SELECT id FROM send_authorizations WHERE message_version_id=? AND kind=? AND permitted_action=? AND status='active'", [v.id as number, d.kind, d.permitted_action]);
  if (same) return { id: same.id as number, created: false };
  const r = await run("INSERT INTO send_authorizations (message_version_id,lead_id,contact_id,channel,campaign_id,kind,permitted_action,approver_id,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [v.id as number, v.lead_id as number, (v.contact_id as number) ?? null, v.channel as string, v.campaign_id as number, d.kind, d.permitted_action, actor.id, d.note ?? null, now()]);
  await audit(actor, `authorize_${d.kind}`, "message_version", v.id as number, { authorization_id: r.id, action: d.permitted_action });
  return { id: r.id, created: true };
}

export async function revoke(actor: Actor, authId: number) {
  const a = await one("SELECT * FROM send_authorizations WHERE id=?", [authId]);
  if (!a) throw new HttpError(404, "Authorization not found.");
  if (a.kind === "send" ? actor.role !== "owner" : !can(actor, "approvals.decide") && actor.role !== "owner") throw new HttpError(403, "You cannot revoke this authorization.");
  const r = await run("UPDATE send_authorizations SET status='revoked' WHERE id=? AND status='active'", [authId]);
  if (!r.changes) throw new HttpError(409, "Only an active authorization can be revoked.");
  await audit(actor, "revoke_authorization", "message_version", a.message_version_id as number, { authorization_id: authId });
}

/* ---------- eligibility ---------- */
export async function checkEligibility(actor: Actor, versionId: number) {
  const v = await one("SELECT * FROM message_versions WHERE id=?", [versionId]);
  if (!v) throw new HttpError(404, "Message version not found.");
  await assertLeadAccess(actor, v.lead_id as number);
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!can(actor, "message.record_sent")) reasons.push("you do not have message.record_sent, so this send could not be recorded");
  if ((await latestVersion(v)) !== v.id) reasons.push("a newer version of this message exists; authorization never carries over to edited text");
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
  return { eligible: reasons.length === 0, reasons, warnings, authorization_id: (auth?.id as number) ?? null, message_version_id: versionId };
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
