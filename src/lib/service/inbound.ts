import { z } from "zod";
import { all, one, run, tx, now, type Row } from "../db";
import { HttpError, requirePerm, type Actor } from "../auth";
import { audit, parse, optText, parseEventDate, dateProblem } from "./common";
import { assertLeadAccess } from "./leads";
import { evaluateDeliverability, resolveSender } from "./senders";

/**
 * Recording what came IN (replies, bounces). Nothing here sends anything.
 * Both endpoints are idempotent: the same message_id never creates a second record.
 */
export const REPLY_CLASSES = ["interested", "soft", "not_interested", "out_of_office", "auto_reply", "other"] as const;
const AUTO = ["out_of_office", "auto_reply"];
// Stages a reply may move a lead UP from. Anything else (meeting, trial, won, lost, closed...) is never overwritten by a reply.
const RANK: Record<string, number> = { new: 0, researching: 1, ready: 2, contacted: 3, replied: 4, interested: 5 };

const replySchema = z.object({
  lead_id: z.coerce.number().int(),
  contact_id: z.coerce.number().int().nullable().optional(),
  received_at: z.string().min(8, "required: ISO time with offset"),
  from: optText(300),
  subject: optText(300),
  message_id: z.string().trim().min(3, "required: the mail Message-ID (used to de-duplicate)").max(500),
  summary: z.string().trim().min(3, "required: a summary of the reply").max(20000),
  classification: z.enum(REPLY_CLASSES),
  update_stage: z.boolean().optional(),
});

function whenOf(v: string, field: string) {
  const ev = parseEventDate(v);
  if (typeof ev === "string") throw new HttpError(400, dateProblem(ev, field));
  if (ev.precision !== "time" || !ev.at) throw new HttpError(400, `${field}: an exact time is required (ISO with Z or an offset).`);
  if (new Date(ev.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, `${field}: cannot be in the future.`);
  return ev.at;
}

export async function recordReply(actor: Actor, input: unknown) {
  requirePerm(actor, "activity.record");
  const d = parse(replySchema, input);
  const lead = await assertLeadAccess(actor, d.lead_id);
  const at = whenOf(d.received_at, "received_at");
  let contact: Row | null = null;
  if (d.contact_id) {
    contact = await one("SELECT * FROM contacts WHERE id=? AND lead_id=?", [d.contact_id, d.lead_id]);
    if (!contact) throw new HttpError(400, "contact_id: not a contact of this lead.");
  }
  const ext = `reply:${d.message_id}`;
  const dup = await one("SELECT id FROM activities WHERE external_id=?", [ext]);
  if (dup) return { duplicate: true, activity_id: dup.id as number, effects: {} as Record<string, unknown> };

  const auto = AUTO.includes(d.classification);
  const parent = await one(
    `SELECT id,COALESCE(sender_id,1) AS sender_id FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' AND occurred_at<=? ${contact ? "AND (contact_id=? OR contact_id IS NULL)" : ""} ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    contact ? [d.lead_id, at, contact.id as number] : [d.lead_id, at]);
  const t = now();
  const body = `${d.summary}${d.from ? `\n\nFrom: ${d.from}` : ""}`;
  const r = await run(
    `INSERT INTO activities (lead_id,contact_id,parent_id,type,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,classification,sender_id)
     VALUES (?,?,?,?,'email',?,?,?,?,?,?,?,?,'time',?,?,?)`,
    [d.lead_id, (contact?.id as number) ?? null, (parent?.id as number) ?? null, auto ? "note" : "reply", auto ? null : "reply_received",
      auto ? `Auto-reply (${d.classification.replace("_", " ")}): ${d.subject ?? ""}`.trim() : d.subject ?? "Reply", body, d.message_id, actor.id, at, t, lead.is_demo as number, ext, d.classification, (parent?.sender_id as number) ?? null]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    { sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?", args: [at, at, t, d.lead_id] },
  ];
  if (contact && !auto && contact.email_status === "unknown") stmts.push({ sql: "UPDATE contacts SET email_status='ok', updated_at=? WHERE id=?", args: [t, contact.id as number] });
  const effects: Record<string, unknown> = { counted_as_reply: !auto };

  if (!auto && d.update_stage !== false) {
    const cur = lead.stage as string;
    let target: string | null = null;
    if (d.classification === "not_interested") {
      const lost = await one("SELECT key FROM lists WHERE kind='stage' AND flag='lost' AND active=1 ORDER BY position,id LIMIT 1");
      const curFlag = await one("SELECT flag FROM lists WHERE kind='stage' AND key=?", [cur]);
      if (lost && !["won", "lost", "closed"].includes(String(curFlag?.flag ?? ""))) target = lost.key as string;
      else effects.stage_unchanged = `stage "${cur}" is final or no "lost" stage exists`;
    } else {
      const want = d.classification === "interested" ? "interested" : "replied";
      if (cur in RANK && RANK[cur] < RANK[want] && (await one("SELECT key FROM lists WHERE kind='stage' AND key=? AND active=1", [want]))) target = want;
      else effects.stage_unchanged = `stage "${cur}" is already at or beyond "${want}", or not a pre-meeting stage`;
    }
    if (target && target !== cur) {
      stmts.push({ sql: "UPDATE leads SET stage=? WHERE id=?", args: [target, d.lead_id] });
      stmts.push({ sql: "INSERT INTO activities (lead_id,type,title,body,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo) VALUES (?,'status','Stage changed',?,?,?,?,?,?,?)", args: [d.lead_id, `Reply classified as ${d.classification}`, cur, target, actor.id, t, t, lead.is_demo as number] });
      effects.stage = { from: cur, to: target };
    }
  }
  await tx(stmts);

  if (!auto && d.classification === "not_interested") {
    // No more follow-ups to a lead that said no: pending follow-up tasks are cancelled and approvals to send to it are withdrawn.
    const pend = await all("SELECT id,title FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND action_type LIKE '%follow%' COLLATE NOCASE", [d.lead_id]);
    for (const tk of pend) {
      await run("UPDATE tasks SET status='cancelled', blockers=NULL, updated_at=? WHERE id=?", [t, tk.id as number]);
      await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [d.lead_id, tk.id as number, `Task cancelled: ${tk.title}`, "Reply: not interested", actor.id, t, t, lead.is_demo as number]);
      await audit(actor, "task_auto_cancel", "task", tk.id as number, { reason: "reply not_interested", reply_activity_id: r.id });
    }
    const revoked = await run("UPDATE send_authorizations SET status='revoked' WHERE lead_id=? AND kind='send' AND status='active'", [d.lead_id]);
    effects.tasks_cancelled = pend.map((x) => x.id);
    effects.send_authorizations_revoked = revoked.changes;
  }
  await audit(actor, "record_reply", "lead", d.lead_id, { activity_id: r.id, classification: d.classification, message_id: d.message_id, ...effects });
  return { duplicate: false, activity_id: r.id, parent_message_activity_id: (parent?.id as number) ?? null, effects };
}

const bounceSchema = z.object({
  contact_id: z.coerce.number().int(),
  message_id: optText(500),
  bounced_at: z.string().min(8, "required: ISO time with offset"),
  reason: optText(1000),
  sender_id: z.coerce.number().int().optional(),
  sender_email: optText(200).optional(),
});

export async function recordBounce(actor: Actor, input: unknown) {
  requirePerm(actor, "activity.record");
  const d = parse(bounceSchema, input);
  const contact = await one("SELECT * FROM contacts WHERE id=?", [d.contact_id]);
  if (!contact) throw new HttpError(404, "Contact not found.");
  const lead = await assertLeadAccess(actor, contact.lead_id as number);
  const at = whenOf(d.bounced_at, "bounced_at");
  const ext = d.message_id ? `bounce:${d.message_id}` : `bounce:c${d.contact_id}:${at}`;
  const dup = await one("SELECT id FROM activities WHERE external_id=?", [ext]);
  if (dup) return { duplicate: true, activity_id: dup.id as number };

  // The message that bounced: by message-id in the send evidence or reference, otherwise the latest message sent to this contact.
  let parent: Row | null = null;
  let matchedBy = "none";
  if (d.message_id) {
    parent = await one("SELECT a.*, COALESCE(a.sender_id,1) AS sender_id FROM activities a JOIN send_events e ON e.activity_id=a.id WHERE a.lead_id=? AND e.evidence LIKE ? ORDER BY a.id DESC LIMIT 1", [lead.id as number, `%${d.message_id}%`]);
    if (parent) matchedBy = "message_id in the send evidence";
    else if ((parent = await one("SELECT * FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' AND ref=? ORDER BY id DESC LIMIT 1", [lead.id as number, d.message_id]))) matchedBy = "message reference";
  }
  if (!parent) {
    parent = await one("SELECT * FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' AND contact_id=? AND occurred_at<=? ORDER BY occurred_at DESC, id DESC LIMIT 1", [lead.id as number, d.contact_id, at]);
    if (parent) matchedBy = "latest message sent to this contact";
  }
  if (parent) {
    const already = await one("SELECT id FROM activities WHERE parent_id=? AND outcome='bounced'", [parent.id as number]);
    if (already) return { duplicate: true, activity_id: already.id as number, note: "a bounce was already recorded for that message" };
  }
  const t = now();
  const explicit = await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email });
  const senderId = explicit ?? ((parent?.sender_id as number) ?? (await one("SELECT COALESCE(sender_id,1) AS s FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' ORDER BY occurred_at DESC,id DESC LIMIT 1", [lead.id as number]))?.s as number ?? null);
  const r = await run(
    `INSERT INTO activities (lead_id,contact_id,parent_id,type,message_kind,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,sender_id)
     VALUES (?,?,?,'outcome',?,?,'bounced',?,?,?,?,?,?,?,'time',?,?)`,
    [lead.id as number, d.contact_id, (parent?.id as number) ?? null, (parent?.message_kind as string) ?? null, (parent?.channel as string) ?? "email", `Bounce: ${contact.email ?? contact.name}`, d.reason, d.message_id, actor.id, at, t, lead.is_demo as number, ext, senderId]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    { sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?", args: [at, at, t, lead.id as number] },
  ];
  // never downgrade an opt-out to a bounce
  if (contact.email_status !== "opted_out") stmts.push({ sql: "UPDATE contacts SET email_status='bounced', updated_at=? WHERE id=?", args: [t, d.contact_id] });
  await tx(stmts);
  await audit(actor, "record_bounce", "contact", d.contact_id, { activity_id: r.id, message_id: d.message_id, matched_by: matchedBy, sender_id: senderId });
  const guard = senderId && !lead.is_demo ? await evaluateDeliverability(actor, senderId) : { paused: false as boolean, reason: undefined as string | undefined };
  return { duplicate: false, activity_id: r.id, contact_status: contact.email_status === "opted_out" ? "opted_out" : "bounced", parent_message_activity_id: (parent?.id as number) ?? null, matched_by: matchedBy, sender_id: senderId, sender_paused: guard.paused, sender_pause_reason: guard.reason ?? null, eligibility: "future sends to this contact are blocked (contact bounced)" };
}
