import { z } from "zod";
import { all, one, run, tx, now, addDays, todayYmd, type Row } from "../db";
import { HttpError, requirePerm, isManager, type Actor } from "../auth";
import { REPLY_CLASSES, REPLY_CLASS_LABEL, type ReplyClass } from "../constants";
import { audit, parse, optText, parseEventDate, dateProblem } from "./common";
import { assertLeadAccess } from "./leads";
import { evaluateDeliverability, resolveSender } from "./senders";
import { addWorkingHours, delayOpenStep, emailDomain, isFreeMail, marketOfCampaign, roleUsers, seqSettings, stopSequences, systemTask } from "./sequences";

/**
 * Recording what came IN (replies, bounces), and what each one sets in motion. Nothing here sends anything.
 * Both endpoints are idempotent: the same message_id never creates a second record.
 * Every answer lists the automatic effects: tasks cancelled or created, approvals withdrawn, stage change, suppression entries, sequences stopped.
 */
export { REPLY_CLASSES };
const AUTO: readonly string[] = ["out_of_office", "auto_reply"];
// Stages a reply may move a lead UP from. Anything else (meeting, trial, won, lost, closed...) is never overwritten by a reply.
const RANK: Record<string, number> = { new: 0, researching: 1, ready: 2, contacted: 3, replied: 4, interested: 5 };
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const replySchema = z.object({
  lead_id: z.coerce.number().int(),
  contact_id: z.coerce.number().int().nullable().optional(),
  received_at: z.string().min(8, "required: ISO time with offset"),
  from: optText(300),
  subject: optText(300),
  message_id: z.string().trim().min(3, "required: the mail Message-ID (used to de-duplicate)").max(500),
  summary: z.string().trim().min(3, "required: a summary of the reply").max(20000),
  classification: z.enum(REPLY_CLASSES),
  channel: optText(30).optional(),
  update_stage: z.boolean().optional(),
  /** out_of_office: the day the person is back. The pending follow-up moves to the day after. */
  return_date: ymd.nullable().optional(),
  /** referral, or an out-of-office naming someone else: who to contact instead. Never contacted automatically. */
  referred_name: optText(200).optional(),
  referred_details: optText(1000).optional(),
  /** not_now: how long to wait before revisiting (default 90 days). */
  snooze_days: z.coerce.number().int().min(1).max(730).optional(),
});

function whenOf(v: string, field: string) {
  const ev = parseEventDate(v);
  if (typeof ev === "string") throw new HttpError(400, dateProblem(ev, field));
  if (ev.precision !== "time" || !ev.at) throw new HttpError(400, `${field}: an exact time is required (ISO with Z or an offset).`);
  if (new Date(ev.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, `${field}: cannot be in the future.`);
  return ev.at;
}

export async function addSuppression(actor: Actor, e: { kind: "dnc" | "opt_out" | "bounce"; scope: "email" | "domain"; value: string; source: string; note?: string | null; lead_id?: number | null; occurred_at?: string | null }) {
  const v = e.value.trim().toLowerCase();
  if (!v) return false;
  const r = await run("INSERT OR IGNORE INTO suppressions (kind,scope,value,occurred_at,source,note,lead_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [e.kind, e.scope, v, e.occurred_at ?? now(), e.source, e.note ?? null, e.lead_id ?? null, actor.id || null, now()]);
  return r.changes > 0;
}

type ReplyCtx = { activityId: number; contact: Row | null; at: string; cls: ReplyClass; from?: string | null; updateStage?: boolean; returnDate?: string | null; referredName?: string | null; referredDetails?: string | null; snoozeDays?: number; summary?: string | null };
/** What a reply of a given class sets in motion. Used when a reply is recorded and again when it is reclassified. */
async function applyReplyEffects(actor: Actor, lead: Row, c: ReplyCtx) {
  const leadId = lead.id as number;
  const auto = AUTO.includes(c.cls);
  const settings = await seqSettings();
  const t = now();
  const created: { task_id: number; kind: string }[] = [];
  const effects: Record<string, unknown> = { counted_as_reply: !auto };
  const camp = await one("SELECT c.key,c.name FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.lead_id=? AND lc.status='active' ORDER BY lc.id DESC LIMIT 1", [leadId]);
  const group = marketOfCampaign(camp, lead);
  const who = c.referredName ? `${c.referredName}${c.referredDetails ? ` (${c.referredDetails})` : ""}` : null;
  const referredTask = async () => created.push({ kind: "add_referred_contact", task_id: await systemTask(actor, lead, { role: "hunter", type: "Research", action: "add_referred_contact", taskType: "research",
    instructions: `The reply names another person to contact: ${who ?? "see the reply"}. Add them as a contact after checking they are real. Writing to them is a new thread with the normal draft and approval steps; they are never enrolled automatically.` }) });

  if (auto) {
    if (c.cls === "out_of_office" && c.returnDate) {
      const moved = await delayOpenStep(actor, leadId, addDays(c.returnDate, 1), `Out of office until ${c.returnDate}`, settings.ooo_max_delay_days);
      if (moved) effects.step_delayed = moved;
    }
    if (c.cls === "out_of_office" && c.referredName) await referredTask();
    if (created.length) effects.tasks_created = created;
    effects.sequences_stopped = [];
    return effects;
  }

  // 1. The sequence stops for the whole company, on every channel.
  const today = todayYmd();
  const restUntil = c.cls === "not_now" ? addDays(today, c.snoozeDays ?? settings.not_now_days) : null;
  const stop = await stopSequences(actor, leadId, `reply: ${REPLY_CLASS_LABEL[c.cls].toLowerCase()}`, { status: c.cls === "not_now" ? "resting" : "stopped", restUntil, revokeAll: c.cls === "not_interested" || c.cls === "unsubscribe" });
  Object.assign(effects, stop);

  // 2. Stage.
  if (c.updateStage !== false && c.cls !== "unsubscribe") {
    const cur = lead.stage as string;
    const stageOk = async (key: string) => !!(await one("SELECT key FROM lists WHERE kind='stage' AND key=? AND active=1", [key]));
    let target: string | null = null;
    if (c.cls === "not_interested") {
      const lost = await one("SELECT key FROM lists WHERE kind='stage' AND flag='lost' AND active=1 ORDER BY position,id LIMIT 1");
      const curFlag = await one("SELECT flag FROM lists WHERE kind='stage' AND key=?", [cur]);
      if (lost && !["won", "lost", "closed"].includes(String(curFlag?.flag ?? ""))) target = lost.key as string;
      else effects.stage_unchanged = `stage "${cur}" is final or no "lost" stage exists`;
    } else if (c.cls === "not_now" && cur in RANK && (await stageOk("nurture"))) target = "nurture";
    else {
      const want = c.cls === "interested" ? "interested" : "replied";
      if (cur in RANK && RANK[cur] < RANK[want] && (await stageOk(want))) target = want;
      else effects.stage_unchanged = `stage "${cur}" is already at or beyond "${want}", or not a pre-meeting stage`;
    }
    if (target && target !== cur) {
      await tx([
        { sql: "UPDATE leads SET stage=?, updated_at=? WHERE id=?", args: [target, t, leadId] },
        { sql: "INSERT INTO activities (lead_id,type,title,body,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo) VALUES (?,'status','Stage changed',?,?,?,?,?,?,?)", args: [leadId, `Reply classified as ${c.cls}`, cur, target, actor.id, t, t, lead.is_demo as number] },
      ]);
      effects.stage = { from: cur, to: target };
    }
  }

  // 3. Who does what next.
  const handle = async (optional = false) => created.push({ kind: "handle_reply", task_id: await systemTask(actor, lead, { role: "inbox", type: "Reply", action: "handle_reply", taskType: "reply_draft",
    dueAt: addWorkingHours(c.at, settings.reply_sla_hours, group, settings.weekends[group]),
    instructions: `${REPLY_CLASS_LABEL[c.cls]} reply${c.from ? ` from ${c.from}` : ""}${optional ? " (a short thank-you is optional)" : ""}. Answer in the same thread. The answer needs a draft, the Chief's review and the Owner's send approval.${c.summary ? ` Summary: ${c.summary.slice(0, 400)}` : ""}` }) });
  if (c.cls === "interested" || c.cls === "soft" || c.cls === "other") await handle();
  if (c.cls === "interested") effects.owner_alert = "An interested reply: it is on the Owner's and the Chief's dashboard under replies waiting for an answer.";
  if (c.cls === "referral") { await referredTask(); await handle(true); }
  if (c.cls === "not_now") {
    created.push({ kind: "revisit", task_id: await systemTask(actor, lead, { role: "chief", type: "Revisit", action: "revisit", dueOn: restUntil, instructions: `The lead said "not now" on ${today}. Decide whether to write again. A new message is a new thread with the normal approval steps.` }) });
    effects.resting_until = restUntil;
  }
  if (c.cls === "not_interested" || c.cls === "unsubscribe") {
    const kind = c.cls === "unsubscribe" ? "opt_out" : "dnc";
    const contacts = await all("SELECT id,email FROM contacts WHERE lead_id=?", [leadId]);
    const added: string[] = [];
    const emails = new Set<string>(contacts.map((x) => String(x.email ?? "").trim().toLowerCase()).filter(Boolean));
    const fromEmail = /[^\s<>]+@[^\s<>]+/.exec(c.from ?? "")?.[0]?.toLowerCase();
    if (fromEmail) emails.add(fromEmail);
    for (const em of emails) if (await addSuppression(actor, { kind, scope: "email", value: em, source: "reply", note: REPLY_CLASS_LABEL[c.cls], lead_id: leadId, occurred_at: c.at })) added.push(em);
    const dom = (lead.domain as string | null) ?? [...emails].map(emailDomain).find((x) => !isFreeMail(x ?? null)) ?? null;
    if (dom && !isFreeMail(dom) && (await addSuppression(actor, { kind, scope: "domain", value: dom, source: "reply", note: REPLY_CLASS_LABEL[c.cls], lead_id: leadId, occurred_at: c.at }))) added.push(dom);
    effects.suppression_added = added;
    if (c.cls === "unsubscribe") {
      const r = await run(`UPDATE contacts SET email_status='opted_out', updated_at=? WHERE lead_id=?${c.contact ? " AND id=?" : ""}`, c.contact ? [t, leadId, c.contact.id as number] : [t, leadId]);
      effects.contacts_opted_out = r.changes;
    }
  }
  if (created.length) effects.tasks_created = created;

  // 4. Another lead on the same corporate domain: a person decides whether it is the same company. Nothing stops by itself.
  const dom = emailDomain(/[^\s<>]+@[^\s<>]+/.exec(c.from ?? "")?.[0] ?? c.contact?.email);
  if (dom && !isFreeMail(dom)) {
    const others = await all(
      `SELECT DISTINCT l.* FROM leads l JOIN enrollments e ON e.lead_id=l.id AND e.status IN ('running','paused')
       WHERE l.id<>? AND l.is_demo=? AND (l.domain=? OR EXISTS (SELECT 1 FROM contacts x WHERE x.lead_id=l.id AND lower(x.email) LIKE ?)) LIMIT 10`, [leadId, lead.is_demo as number, dom, `%@${dom}`]);
    const reviews: { lead_id: number; task_id: number }[] = [];
    for (const o of others) reviews.push({ lead_id: o.id as number, task_id: await systemTask(actor, o, { role: "chief", type: "Review", action: "review_same_company", dueOn: today,
      instructions: `Possible same company: ${lead.company} (lead ${leadId}) replied from @${dom}, the same mail domain as this lead. If it is the same company, stop this lead's sequence (POST /leads/${o.id}/sequence {action: "stop", reason}). Nothing was stopped automatically.` }) });
    if (reviews.length) effects.same_company_reviews = reviews;
  }
  return effects;
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
  const labels = (await one("SELECT labels FROM enrollments WHERE lead_id=? AND labels IS NOT NULL ORDER BY (channel='email') DESC LIMIT 1", [d.lead_id]))?.labels ?? null;
  const r = await run(
    `INSERT INTO activities (lead_id,contact_id,parent_id,type,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,classification,sender_id,labels,classified_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'time',?,?,?,?,?)`,
    [d.lead_id, (contact?.id as number) ?? null, (parent?.id as number) ?? null, auto ? "note" : "reply", d.channel ?? "email", auto ? null : "reply_received",
      auto ? `Auto-reply (${d.classification.replace(/_/g, " ")}): ${d.subject ?? ""}`.trim() : d.subject ?? "Reply", body, d.message_id, actor.id, at, t, lead.is_demo as number, ext, d.classification, (parent?.sender_id as number) ?? null, labels as string | null, actor.id]);
  await run("INSERT INTO reply_classifications (activity_id,from_class,to_class,reason,actor_id,actor_kind,created_at) VALUES (?,NULL,?,NULL,?,?,?)", [r.id, d.classification, actor.id, actor.isAgent ? "agent" : "person", t]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    { sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?", args: [at, at, t, d.lead_id] },
  ];
  if (contact && !auto && contact.email_status === "unknown") stmts.push({ sql: "UPDATE contacts SET email_status='ok', updated_at=? WHERE id=?", args: [t, contact.id as number] });
  await tx(stmts);
  const effects = await applyReplyEffects(actor, lead, { activityId: r.id, contact, at, cls: d.classification, from: d.from, updateStage: d.update_stage, returnDate: d.return_date, referredName: d.referred_name, referredDetails: d.referred_details, snoozeDays: d.snooze_days, summary: d.summary });
  await audit(actor, "record_reply", "lead", d.lead_id, { activity_id: r.id, classification: d.classification, message_id: d.message_id, ...effects });
  return { duplicate: false, activity_id: r.id, parent_message_activity_id: (parent?.id as number) ?? null, effects };
}

const reclassSchema = z.object({ classification: z.enum(REPLY_CLASSES), reason: z.string().trim().min(3, "reason: say why the class is changed").max(1000), return_date: ymd.nullable().optional(), referred_name: optText(200).optional(), referred_details: optText(1000).optional(), snooze_days: z.coerce.number().int().min(1).max(730).optional() });
/**
 * Owner, Chief or the reply handler changes a reply's class. The effects of the NEW class run again.
 * Stricter effects of the old class are not undone: cancelled tasks, withdrawn approvals and suppression entries stay.
 */
export async function reclassifyReply(actor: Actor, activityId: number, input: unknown) {
  const d = parse(reclassSchema, input);
  if (!isManager(actor) && (await roleUsers()).inbox !== actor.id) throw new HttpError(403, "Only the Owner, a Chief or the reply handler can reclassify a reply.");
  const a = await one("SELECT * FROM activities WHERE id=? AND classification IS NOT NULL AND external_id LIKE 'reply:%'", [activityId]);
  if (!a) throw new HttpError(404, "Reply not found.");
  const lead = await assertLeadAccess(actor, a.lead_id as number);
  const from = a.classification as string;
  if (from === d.classification) throw new HttpError(409, `This reply is already classified as ${from}.`);
  const auto = AUTO.includes(d.classification);
  const t = now();
  await run("UPDATE activities SET classification=?, type=?, outcome=?, classified_by=? WHERE id=?", [d.classification, auto ? "note" : "reply", auto ? null : "reply_received", actor.id, activityId]);
  await run("INSERT INTO reply_classifications (activity_id,from_class,to_class,reason,actor_id,actor_kind,created_at) VALUES (?,?,?,?,?,?,?)", [activityId, from, d.classification, d.reason, actor.id, actor.isAgent ? "agent" : "person", t]);
  const contact = a.contact_id ? await one("SELECT * FROM contacts WHERE id=?", [a.contact_id as number]) : null;
  const fromLine = /\n\nFrom: (.+)$/.exec(String(a.body ?? ""))?.[1] ?? null;
  const effects = await applyReplyEffects(actor, lead, { activityId, contact, at: a.occurred_at as string, cls: d.classification, from: fromLine, returnDate: d.return_date, referredName: d.referred_name, referredDetails: d.referred_details, snoozeDays: d.snooze_days, summary: String(a.body ?? "").split("\n\nFrom: ")[0] });
  await audit(actor, "reply_reclassified", "lead", lead.id as number, { activity_id: activityId, from, to: d.classification, reason: d.reason, ...effects });
  return { activity_id: activityId, from, to: d.classification, effects, not_undone: "Effects of the earlier class that were stricter stay as they are: cancelled tasks, withdrawn send approvals and suppression entries. A Chief can resume a paused sequence; removing a suppression entry is for the Owner." };
}

/** Replies with their class, who classified them, the reclassification history and how fast they were handled. */
export async function listReplies(actor: Actor, q: { lead_id?: number; from?: string; to?: string; limit?: number } = {}) {
  if (!isManager(actor) && !actor.perms.has("leads.view_all")) throw new HttpError(403, "You cannot list every reply.");
  const where = ["a.external_id LIKE 'reply:%'", "a.is_demo=0"];
  const args: (string | number)[] = [];
  if (q.lead_id) (where.push("a.lead_id=?"), args.push(q.lead_id));
  if (q.from) (where.push("a.occurred_at>=?"), args.push(q.from));
  if (q.to) (where.push("a.occurred_at<?"), args.push(q.to));
  const rows = await all(
    `SELECT a.id,a.lead_id,l.company,a.contact_id,a.occurred_at AS received_at,a.created_at AS recorded_at,a.classification,a.title AS subject,a.body AS summary,a.ref AS message_id,a.labels,a.sender_id,u.name AS classified_by,COALESCE(u.is_agent,0) AS classified_by_agent,
            (SELECT MIN(m.occurred_at) FROM activities m WHERE m.lead_id=a.lead_id AND m.type='message' AND m.outcome='sent' AND m.occurred_at>a.occurred_at) AS answered_at
     FROM activities a JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=COALESCE(a.classified_by,a.actor_id) WHERE ${where.join(" AND ")} ORDER BY a.occurred_at DESC LIMIT ?`, [...args, Math.min(Math.max(q.limit ?? 100, 1), 500)]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as number);
  const leadIds = [...new Set(rows.map((r) => r.lead_id as number))];
  const [hist, tasks] = await Promise.all([
    all(`SELECT h.activity_id,h.from_class,h.to_class,h.reason,h.actor_kind,h.created_at,u.name AS by_name FROM reply_classifications h LEFT JOIN users u ON u.id=h.actor_id WHERE h.activity_id IN (${ids.map(() => "?").join(",")}) ORDER BY h.id`, ids),
    all(`SELECT id,lead_id,created_at,due_at,completed_at,status FROM tasks WHERE action_type='handle_reply' AND lead_id IN (${leadIds.map(() => "?").join(",")}) ORDER BY id`, leadIds),
  ]);
  return rows.map((r) => {
    const tk = tasks.filter((x) => x.lead_id === r.lead_id && (x.created_at as string) >= (r.recorded_at as string))[0] ?? null;
    let labels: string[] = [];
    try { labels = r.labels ? (JSON.parse(String(r.labels)) as string[]) : []; } catch { labels = []; }
    return { ...r, labels: undefined, experiment_labels: labels, counted_as_reply: !AUTO.includes(String(r.classification)), classified_by_kind: r.classified_by_agent ? "agent" : "person", classified_by_agent: undefined,
      history: hist.filter((h) => h.activity_id === r.id), handling: tk ? { task_id: tk.id, created_at: tk.created_at, deadline: tk.due_at, completed_at: tk.completed_at, status: tk.status } : null };
  });
}

const bounceSchema = z.object({
  contact_id: z.coerce.number().int(),
  message_id: optText(500),
  bounced_at: z.string().min(8, "required: ISO time with offset"),
  reason: optText(1000),
  sender_id: z.coerce.number().int().optional(),
  sender_email: optText(200).optional(),
  /** hard (default): the address does not work. soft: mailbox full or a temporary failure; the step waits 3 days. A second soft bounce on the same contact counts as hard. */
  bounce_type: z.enum(["hard", "soft"]).optional(),
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
  const settings = await seqSettings();
  const earlierSoft = Number((await one("SELECT COUNT(*) AS n FROM activities WHERE contact_id=? AND bounce_type='soft'", [d.contact_id]))!.n);
  if (d.bounce_type === "soft" && earlierSoft === 0) {
    // First soft bounce: the address stays usable, nothing counts against the sender, and the open step waits.
    const sr = await run(
      `INSERT INTO activities (lead_id,contact_id,parent_id,type,channel,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,bounce_type,sender_id)
       VALUES (?,?,?,'note',?,?,?,?,?,?,?,?,'time',?,'soft',?)`,
      [lead.id as number, d.contact_id, (parent?.id as number) ?? null, (parent?.channel as string) ?? "email", `Soft bounce: ${contact.email ?? contact.name}`, d.reason, d.message_id, actor.id, at, t, lead.is_demo as number, ext, (parent?.sender_id as number) ?? null]);
    const held = await delayOpenStep(actor, lead.id as number, addDays(todayYmd(), settings.soft_bounce_hold_days), `Soft bounce: try again after ${settings.soft_bounce_hold_days} days`, 30);
    await audit(actor, "record_soft_bounce", "contact", d.contact_id, { activity_id: sr.id, message_id: d.message_id, step_held: held });
    return { duplicate: false, activity_id: sr.id, bounce_type: "soft", counted_as_hard: false, contact_status: contact.email_status, parent_message_activity_id: (parent?.id as number) ?? null, matched_by: matchedBy, sender_paused: false,
      effects: { step_held: held, note: `The step waits ${settings.soft_bounce_hold_days} days, then returns to the plan. A second soft bounce on this contact counts as a hard bounce.` } };
  }
  const explicit = await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email });
  const senderId = explicit ?? ((parent?.sender_id as number) ?? (await one("SELECT COALESCE(sender_id,1) AS s FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' ORDER BY occurred_at DESC,id DESC LIMIT 1", [lead.id as number]))?.s as number ?? null);
  const r = await run(
    `INSERT INTO activities (lead_id,contact_id,parent_id,type,message_kind,channel,outcome,title,body,ref,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,sender_id,bounce_type)
     VALUES (?,?,?,'outcome',?,?,'bounced',?,?,?,?,?,?,?,'time',?,?,?)`,
    [lead.id as number, d.contact_id, (parent?.id as number) ?? null, (parent?.message_kind as string) ?? null, (parent?.channel as string) ?? "email", `Bounce: ${contact.email ?? contact.name}`, d.reason, d.message_id, actor.id, at, t, lead.is_demo as number, ext, senderId, d.bounce_type === "soft" ? "soft_as_hard" : "hard"]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    { sql: "UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?", args: [at, at, t, lead.id as number] },
  ];
  // never downgrade an opt-out to a bounce
  if (contact.email_status !== "opted_out") stmts.push({ sql: "UPDATE contacts SET email_status='bounced', updated_at=? WHERE id=?", args: [t, d.contact_id] });
  await tx(stmts);
  await audit(actor, "record_bounce", "contact", d.contact_id, { activity_id: r.id, message_id: d.message_id, matched_by: matchedBy, sender_id: senderId });
  const guard = senderId && !lead.is_demo ? await evaluateDeliverability(actor, senderId) : { paused: false as boolean, reason: undefined as string | undefined };
  // The sequence stops for this address. Another usable contact is suggested to a person, never used automatically.
  const effects: Record<string, unknown> = { ...(await stopSequences(actor, lead.id as number, "bounce", { channels: ["email"] })) };
  if (contact.email) await addSuppression(actor, { kind: "bounce", scope: "email", value: String(contact.email), source: "bounce", lead_id: lead.id as number, occurred_at: at });
  if (!lead.historical_only) {
    const alt = await one("SELECT id,name FROM contacts WHERE lead_id=? AND id<>? AND email IS NOT NULL AND email<>'' AND email_status NOT IN ('bounced','opted_out') AND is_invalid=0 ORDER BY is_primary DESC, id LIMIT 1", [lead.id as number, d.contact_id]);
    if (alt) effects.tasks_created = [{ kind: "choose_alternate_contact", task_id: await systemTask(actor, lead, { role: "hunter", type: "Research", action: "choose_alternate_contact", taskType: "research", instructions: `The address of ${contact.name} bounced. Another contact exists (${alt.name}). Check that this person is right for the message. Writing to them is a new thread with the normal approval steps.` }) }];
    else {
      effects.tasks_created = [{ kind: "find_contact", task_id: await systemTask(actor, lead, { role: "hunter", type: "Research", action: "find_contact", taskType: "research", instructions: `The address of ${contact.name} bounced and the lead has no other usable contact. Find a working contact.` }) }];
      if (await one("SELECT key FROM lists WHERE kind='stage' AND key='unreachable' AND active=1")) {
        await run("UPDATE leads SET stage='unreachable', updated_at=? WHERE id=?", [t, lead.id as number]);
        await run("INSERT INTO activities (lead_id,type,title,body,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo) VALUES (?,'status','Stage changed','Hard bounce and no other contact',?,'unreachable',?,?,?,?)", [lead.id as number, lead.stage as string, actor.id, t, t, lead.is_demo as number]);
        effects.stage = { from: lead.stage, to: "unreachable" };
      }
    }
  }
  return { duplicate: false, bounce_type: d.bounce_type ?? "hard", counted_as_hard: true, effects, activity_id: r.id, contact_status: contact.email_status === "opted_out" ? "opted_out" : "bounced", parent_message_activity_id: (parent?.id as number) ?? null, matched_by: matchedBy, sender_id: senderId, sender_paused: guard.paused, sender_pause_reason: guard.reason ?? null, eligibility: "future sends to this contact are blocked (contact bounced)" };
}
