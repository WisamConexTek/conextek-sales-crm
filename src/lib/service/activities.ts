import { z } from "zod";
import { one, run, now, tx } from "../db";
import { HttpError, requirePerm, isManager, type Actor } from "../auth";
import { MESSAGE_KINDS, RECORDABLE_TYPES } from "../constants";
import { parse, optText, optInt, assertListKey, parseEventDate } from "./common";
import { assertLeadAccess } from "./leads";

const schema = z.object({
  type: z.enum(RECORDABLE_TYPES),
  message_kind: z.enum(MESSAGE_KINDS).nullable().optional(),
  channel: optText(40),
  outcome: z.enum(["bounced", "no_response_yet", "opted_out", "reply_received"]).nullable().optional(),
  title: optText(200),
  body: optText(20000),
  ref: optText(300),
  url: optText(600),
  contact_id: optInt,
  task_id: optInt,
  parent_id: optInt,
  occurred_at: z.unknown().optional(),
});

/**
 * Record work that ALREADY happened outside the CRM.
 * Nothing here sends anything. A "message" entry means the user attests it was really sent.
 */
export async function recordActivity(actor: Actor, leadId: number, input: unknown) {
  requirePerm(actor, "activity.record");
  const lead = await assertLeadAccess(actor, leadId);
  const raw = input as Record<string, unknown>;
  const d = parse(schema, { ...raw, message_kind: raw?.message_kind || null, outcome: raw?.outcome || null });
  const warnings: string[] = [];

  // Omitted = it just happened. A date without hour is kept as that day. "unknown" stays unknown (never turned into today).
  const blank = d.occurred_at == null || (typeof d.occurred_at === "string" && d.occurred_at.trim() === "");
  const ev = blank ? ({ at: now(), precision: "time" } as const) : parseEventDate(d.occurred_at);
  if (ev === "invalid") throw new HttpError(400, 'occurred_at: use YYYY-MM-DD (date only), YYYY-MM-DDTHH:mm, an ISO time, or "unknown".');
  if (ev.at && new Date(ev.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, "occurred_at: cannot be in the future — record work only after it happened.");
  const unknownDate = ev.precision === "unknown";
  const occurred = ev.at ?? now(); // for unknown dates this is only the registration time, flagged by occurred_precision
  if (d.channel) await assertListKey("channel", d.channel, "channel");

  let contact = null as Record<string, unknown> | null;
  if (d.contact_id) {
    contact = await one("SELECT * FROM contacts WHERE id=? AND lead_id=?", [d.contact_id, leadId]);
    if (!contact) throw new HttpError(400, "contact_id: not a contact of this lead.");
  }
  if (d.task_id) {
    const task = await one("SELECT * FROM tasks WHERE id=?", [d.task_id]);
    if (!task) throw new HttpError(400, "task_id: task not found.");
    if (task.assignee_id !== actor.id && !isManager(actor)) throw new HttpError(403, "task_id: that task is not assigned to you.");
    if (task.lead_id && task.lead_id !== leadId) throw new HttpError(400, "task_id: that task belongs to another lead.");
  }

  let outcome: string | null = null;
  let kind: string | null = null;
  let parentId: number | null = null;
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];

  switch (d.type) {
    case "message": {
      requirePerm(actor, "message.record_sent");
      if (!d.message_kind) throw new HttpError(400, "message_kind: first_email, follow_up or other is required for a sent message.");
      if (!d.body && !d.title && !d.ref && !d.url) throw new HttpError(400, "Include the subject/body or a message reference or link.");
      kind = d.message_kind;
      outcome = "sent";
      if (contact && (contact.email_status === "opted_out" || contact.email_status === "bounced"))
        warnings.push(`Contact "${contact.name}" is marked ${contact.email_status}. Recorded as requested — check the rules before sending again.`);
      break;
    }
    case "reply":
      outcome = "reply_received";
      if (!d.body && !d.ref && !d.url) throw new HttpError(400, "Paste the reply text or give a reference/link.");
      parentId = d.parent_id ?? null;
      break;
    case "outcome": {
      if (!d.parent_id) throw new HttpError(400, "parent_id: the sent message this outcome relates to is required.");
      const parent = await one("SELECT * FROM activities WHERE id=? AND lead_id=? AND type='message'", [d.parent_id, leadId]);
      if (!parent) throw new HttpError(400, "parent_id: must be a sent message on this lead.");
      if (!d.outcome || !["bounced", "no_response_yet", "opted_out"].includes(d.outcome))
        throw new HttpError(400, "outcome: bounced, no_response_yet or opted_out.");
      if (d.outcome === "bounced" && (await one("SELECT id FROM activities WHERE parent_id=? AND outcome='bounced'", [d.parent_id])))
        throw new HttpError(409, "A bounce is already recorded for that message.");
      outcome = d.outcome;
      parentId = d.parent_id;
      kind = parent.message_kind;
      if (!contact && parent.contact_id) contact = await one("SELECT * FROM contacts WHERE id=?", [parent.contact_id]);
      break;
    }
    default:
      if (!d.body && !d.title && !d.url) throw new HttpError(400, "Write what was found / drafted (body or title).");
  }

  const t = now();
  const r = await run(
    `INSERT INTO activities (lead_id,contact_id,task_id,parent_id,type,message_kind,channel,outcome,title,body,ref,url,actor_id,occurred_at,created_at,is_demo,occurred_precision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [leadId, (contact?.id as number) ?? d.contact_id ?? null, d.task_id ?? null, parentId, d.type, kind, d.channel, outcome, d.title, d.body, d.ref, d.url,
      actor.id, occurred, t, lead.is_demo, ev.precision],
  );

  // Contact deliverability follows what actually happened.
  if (contact) {
    const cid = contact.id as number;
    if (d.type === "outcome" && outcome === "bounced") stmts.push({ sql: "UPDATE contacts SET email_status='bounced', updated_at=? WHERE id=?", args: [t, cid] });
    if (d.type === "outcome" && outcome === "opted_out") stmts.push({ sql: "UPDATE contacts SET email_status='opted_out', updated_at=? WHERE id=?", args: [t, cid] });
    if (d.type === "reply" && contact.email_status === "unknown") stmts.push({ sql: "UPDATE contacts SET email_status='ok', updated_at=? WHERE id=?", args: [t, cid] });
  }
  if (unknownDate) stmts.push({ sql: "UPDATE leads SET updated_at=? WHERE id=?", args: [t, leadId] });
  else stmts.push({
    sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?",
    args: [occurred, occurred, t, leadId],
  });
  await tx(stmts);
  return { id: r.id, warnings };
}
