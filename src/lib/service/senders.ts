import { z } from "zod";
import { all, one, run, tx, now, localMidnight, addDays, todayYmd, TZ, type Row } from "../db";
import { HttpError, type Actor } from "../auth";
import { audit, parse, optText } from "./common";

/**
 * Sending mailboxes ("senders"). The CRM never sends: a sender is the identity a message is SENT FROM by the browser workflow.
 * Every message version and every recorded send names its sender. Caps, warm-up and the deliverability guard are per sender.
 */
export const DEFAULT_SENDER_ID = 1;
export const BOUNCE_LIMIT = 0.03;
export const LANGUAGES = ["en", "ar", "zh"] as const;

export type Sender = {
  id: number; email: string; display_name: string; title: string | null; domain: string;
  languages: string[]; campaign_ids: number[] | null; daily_cap: number | null; active: boolean;
  paused_at: string | null; paused_by: number | null; pause_reason: string | null; pause_kind: "auto" | "manual" | null; resumed_at: string | null;
  created_at: string; updated_at: string;
};
export type Step = { from_date: string; daily_cap: number };

const jsonArr = (v: unknown): unknown[] | null => {
  if (v == null || v === "") return null;
  try { const x = JSON.parse(String(v)); return Array.isArray(x) ? x : null; } catch { return null; }
};
export function toSender(r: Row): Sender {
  return {
    id: r.id as number, email: r.email as string, display_name: r.display_name as string, title: (r.title as string) ?? null, domain: r.domain as string,
    languages: ((jsonArr(r.languages) ?? ["en"]) as string[]).map(String), campaign_ids: jsonArr(r.campaign_ids) === null ? null : (jsonArr(r.campaign_ids) as unknown[]).map(Number),
    daily_cap: r.daily_cap == null ? null : Number(r.daily_cap), active: !!r.active,
    paused_at: (r.paused_at as string) ?? null, paused_by: (r.paused_by as number) ?? null, pause_reason: (r.pause_reason as string) ?? null,
    pause_kind: (r.pause_kind as "auto" | "manual") ?? null, resumed_at: (r.resumed_at as string) ?? null,
    created_at: r.created_at as string, updated_at: r.updated_at as string,
  };
}

/** Senders and their warm-up steps in two queries. */
export async function loadSenders(): Promise<{ senders: Sender[]; steps: Map<number, Step[]> }> {
  const [rows, st] = await Promise.all([
    all("SELECT * FROM senders ORDER BY id"),
    all("SELECT sender_id,from_date,daily_cap FROM sender_warmup ORDER BY sender_id,from_date"),
  ]);
  const steps = new Map<number, Step[]>();
  for (const s of st) (steps.get(s.sender_id as number) ?? steps.set(s.sender_id as number, []).get(s.sender_id as number)!).push({ from_date: s.from_date as string, daily_cap: Number(s.daily_cap) });
  return { senders: rows.map(toSender), steps };
}

/** The cap for one Asia/Hebron day. null = no cap. With a warm-up schedule: the latest step on or before that day, and 0 before the first step. */
export function capOn(sender: Sender, steps: Step[] | undefined, ymd: string): { cap: number | null; step_from: string | null; warmup: boolean; not_started: boolean } {
  if (steps && steps.length) {
    const cur = [...steps].filter((x) => x.from_date <= ymd).pop();
    return { cap: cur ? cur.daily_cap : 0, step_from: cur?.from_date ?? null, warmup: true, not_started: !cur };
  }
  return { cap: sender.daily_cap, step_from: null, warmup: false, not_started: false };
}

export type SenderStatus = "active" | "warming_up" | "paused" | "inactive";
export function statusOn(sender: Sender, steps: Step[] | undefined, ymd: string): SenderStatus {
  if (!sender.active) return "inactive";
  if (sender.paused_at) return "paused";
  if (steps && steps.length && ymd < steps[steps.length - 1].from_date) return "warming_up";
  return "active";
}

/* ---------- language ---------- */
/** Which language a text is written in: ar (Arabic script), zh (Han characters) or en (everything else). */
export function detectLanguage(text: string): "en" | "ar" | "zh" {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return "en";
  const ar = letters.filter((c) => /[؀-ۿݐ-ݿࢠ-ࣿ]/.test(c)).length;
  const zh = letters.filter((c) => /[一-鿿]/.test(c)).length;
  if (ar / letters.length >= 0.3) return "ar";
  if (zh / letters.length >= 0.3) return "zh";
  return "en";
}

/* ---------- reads / settings (Owner) ---------- */
export async function listSenders() {
  const { senders, steps } = await loadSenders();
  const today = todayYmd();
  return senders.map((s) => ({ ...s, warmup: steps.get(s.id) ?? [], cap_today: capOn(s, steps.get(s.id), today), status: statusOn(s, steps.get(s.id), today) }));
}
export async function getSender(id: number) {
  const r = (await listSenders()).find((s) => s.id === id);
  if (!r) throw new HttpError(404, "Sender not found.");
  return r;
}
export async function resolveSender(input: { sender_id?: number | null; sender_email?: string | null }): Promise<number | null> {
  if (input.sender_id) {
    if (!(await one("SELECT id FROM senders WHERE id=?", [input.sender_id]))) throw new HttpError(400, `sender_id: unknown sender ${input.sender_id}.`);
    return input.sender_id;
  }
  if (input.sender_email) {
    const r = await one("SELECT id FROM senders WHERE lower(email)=lower(?)", [input.sender_email.trim()]);
    if (!r) throw new HttpError(400, `sender_email: unknown sender "${input.sender_email}".`);
    return r.id as number;
  }
  return null;
}

const ownerOnly = (actor: Actor, what: string) => { if (actor.role !== "owner") throw new HttpError(403, `Only the Owner can ${what}.`); };
const campaignsField = z.preprocess((v) => (v === "" ? null : v), z.array(z.coerce.number().int()).max(200).nullable().optional());
const langField = z.array(z.enum(LANGUAGES)).min(1, "at least one language").max(5);
const senderBase = {
  email: z.string().trim().toLowerCase().email("a valid email address").max(200),
  display_name: z.string().trim().min(1, "required").max(120),
  title: optText(120).optional(),
  domain: z.string().trim().toLowerCase().min(3).max(200).optional(),
  languages: langField.optional(),
  campaign_ids: campaignsField,
  daily_cap: z.preprocess((v) => (v === "" || v === undefined ? undefined : v === null ? null : Number(v)), z.number().int().min(0).max(5000).nullable().optional()),
  active: z.boolean().optional(),
};
async function checkCampaigns(ids: number[] | null | undefined) {
  if (!ids) return;
  for (const id of ids) if (!(await one("SELECT id FROM campaigns WHERE id=?", [id]))) throw new HttpError(400, `campaign_ids: unknown campaign ${id}.`);
}

export async function createSender(actor: Actor, input: unknown) {
  ownerOnly(actor, "add a sender");
  const d = parse(z.object(senderBase), input);
  if (await one("SELECT id FROM senders WHERE lower(email)=?", [d.email])) throw new HttpError(409, "A sender with this email already exists.");
  await checkCampaigns(d.campaign_ids);
  const t = now();
  const r = await run("INSERT INTO senders (email,display_name,title,domain,languages,campaign_ids,daily_cap,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [d.email, d.display_name, d.title ?? null, d.domain ?? d.email.split("@")[1], JSON.stringify(d.languages ?? ["en"]), d.campaign_ids ? JSON.stringify(d.campaign_ids) : null, d.daily_cap ?? 0, d.active === false ? 0 : 1, t, t]);
  await run("INSERT INTO sender_events (sender_id,action,actor_id,actor_name,created_at) VALUES (?,?,?,?,?)", [r.id, "created", actor.id, actor.name, t]);
  await audit(actor, "create_sender", "sender", r.id, { email: d.email });
  return getSender(r.id);
}

export async function updateSender(actor: Actor, id: number, input: unknown) {
  ownerOnly(actor, "change a sender");
  const before = await getSender(id);
  const d = parse(z.object({ ...senderBase, email: senderBase.email.optional(), display_name: senderBase.display_name.optional() }), input);
  if (d.email && d.email !== before.email && (await one("SELECT id FROM senders WHERE lower(email)=? AND id<>?", [d.email, id]))) throw new HttpError(409, "Another sender already uses this email.");
  await checkCampaigns(d.campaign_ids);
  const sets: string[] = []; const args: (string | number | null)[] = [];
  const set = (c: string, v: string | number | null) => (sets.push(`${c}=?`), args.push(v));
  if (d.email !== undefined) set("email", d.email);
  if (d.display_name !== undefined) set("display_name", d.display_name);
  if (d.title !== undefined) set("title", d.title);
  if (d.domain !== undefined) set("domain", d.domain);
  if (d.languages !== undefined) set("languages", JSON.stringify(d.languages));
  if (d.campaign_ids !== undefined) set("campaign_ids", d.campaign_ids ? JSON.stringify(d.campaign_ids) : null);
  if (d.daily_cap !== undefined) set("daily_cap", d.daily_cap);
  if (d.active !== undefined) set("active", d.active ? 1 : 0);
  if (!sets.length) throw new HttpError(400, "Nothing to change.");
  set("updated_at", now());
  await run(`UPDATE senders SET ${sets.join(",")} WHERE id=?`, [...args, id]);
  const after = await getSender(id);
  await run("INSERT INTO sender_events (sender_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)", [id, d.active !== undefined && d.active !== before.active ? (d.active ? "activated" : "deactivated") : "updated", actor.id, actor.name, JSON.stringify({ from: { ...before, warmup: undefined, cap_today: undefined }, to: { ...after, warmup: undefined, cap_today: undefined } }), now()]);
  await audit(actor, "update_sender", "sender", id, { changed: sets.map((s) => s.split("=")[0]).filter((c) => c !== "updated_at") });
  return after;
}

export function parseSteps(input: unknown): Step[] {
  const arr = z.array(z.object({ from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"), daily_cap: z.coerce.number().int().min(0).max(5000) })).max(60);
  const steps = parse(arr, input);
  const seen = new Set<string>();
  for (const s of steps) { if (seen.has(s.from_date)) throw new HttpError(400, `steps: ${s.from_date} appears twice.`); seen.add(s.from_date); }
  return steps.sort((a, b) => a.from_date.localeCompare(b.from_date));
}
/** Owner replaces a sender's warm-up schedule. An empty list switches warm-up off (the sender's plain daily_cap applies). */
export async function setWarmup(actor: Actor, id: number, input: unknown) {
  ownerOnly(actor, "edit a warm-up schedule");
  const before = await getSender(id);
  const steps = parseSteps((input as { steps?: unknown })?.steps ?? input);
  await tx([
    { sql: "DELETE FROM sender_warmup WHERE sender_id=?", args: [id] },
    ...steps.map((s) => ({ sql: "INSERT INTO sender_warmup (sender_id,from_date,daily_cap) VALUES (?,?,?)", args: [id, s.from_date, s.daily_cap] as (string | number)[] })),
    { sql: "INSERT INTO sender_events (sender_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)", args: [id, "warmup_updated", actor.id, actor.name, JSON.stringify({ from: before.warmup, to: steps }), now()] },
  ]);
  await audit(actor, "update_sender_warmup", "sender", id, { from: before.warmup, to: steps });
  return getSender(id);
}

/** "2026-11-10: 5" per line -> steps (used by the Settings form). */
export function stepsFromText(text: string): Step[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2})\s*[:=,]?\s*(\d+)$/);
    if (!m) throw new HttpError(400, `Warm-up line "${line}": write it as 2026-11-10: 5 (date, then messages per day).`);
    out.push({ from_date: m[1], daily_cap: Number(m[2]) });
  }
  return parseSteps(out);
}

/* ---------- pause / resume ---------- */
export async function senderLog(actor: Actor, id?: number) {
  void actor;
  return all(`SELECT e.id,e.sender_id,s.email,e.action,e.reason,e.actor_name,e.auto,e.detail,e.created_at FROM sender_events e JOIN senders s ON s.id=e.sender_id ${id ? "WHERE e.sender_id=?" : ""} ORDER BY e.id DESC LIMIT 100`, id ? [id] : []);
}

export async function pauseSender(actor: Actor, id: number, reason: unknown) {
  ownerOnly(actor, "pause a sender");
  const why = parse(z.string().trim().min(3, "reason: say why").max(1000), (reason as { reason?: unknown })?.reason ?? reason);
  const s = await getSender(id);
  if (s.paused_at) throw new HttpError(409, "Already paused.");
  const t = now();
  await tx([
    { sql: "UPDATE senders SET paused_at=?, paused_by=?, pause_reason=?, pause_kind='manual', updated_at=? WHERE id=?", args: [t, actor.id, why, t, id] },
    { sql: "INSERT INTO sender_events (sender_id,action,reason,actor_id,actor_name,auto,created_at) VALUES (?,?,?,?,?,0,?)", args: [id, "paused", why, actor.id, actor.name, t] },
  ]);
  await audit(actor, "pause_sender", "sender", id, { reason: why });
  return getSender(id);
}
export async function resumeSender(actor: Actor, id: number, reason: unknown) {
  ownerOnly(actor, "resume a sender");
  const why = parse(z.string().trim().min(3, "reason: say why it is safe to resume").max(1000), (reason as { reason?: unknown })?.reason ?? reason);
  const s = await getSender(id);
  if (!s.paused_at) throw new HttpError(409, "This sender is not paused.");
  const t = now();
  await tx([
    { sql: "UPDATE senders SET paused_at=NULL, paused_by=NULL, pause_reason=NULL, pause_kind=NULL, resumed_at=?, updated_at=? WHERE id=?", args: [t, t, id] },
    { sql: "INSERT INTO sender_events (sender_id,action,reason,actor_id,actor_name,auto,detail,created_at) VALUES (?,?,?,?,?,0,?,?)", args: [id, "resumed", why, actor.id, actor.name, JSON.stringify({ was: s.pause_reason, was_kind: s.pause_kind }), t] },
  ]);
  await audit(actor, "resume_sender", "sender", id, { reason: why, was: s.pause_reason });
  return getSender(id);
}

/* ---------- deliverability ---------- */
const WEEK = 7 * 86400000;
const SENDER_OF = "COALESCE(a.sender_id, p.sender_id, 1)";
export type Health = { sender_id: number; since: string; sent: number; bounces: number; replies: number; complaints: number; bounce_rate: number | null };

/** 7-day rolling numbers per sender. `from` overrides the window start (used by the guard after a resume). */
export async function senderStats(from?: Map<number, string>): Promise<Map<number, Health>> {
  const since = new Date(Date.now() - WEEK).toISOString();
  const [acts, comps, ids] = await Promise.all([
    all(`SELECT ${SENDER_OF} AS sid, a.type, a.outcome, a.occurred_at FROM activities a LEFT JOIN activities p ON p.id=a.parent_id
         WHERE a.is_demo=0 AND a.occurred_precision<>'unknown' AND a.occurred_at>=? AND ((a.type='message' AND a.outcome='sent') OR a.outcome IN ('bounced','reply_received'))`, [since]),
    all("SELECT sender_id AS sid, occurred_at FROM spam_complaints WHERE occurred_at>=?", [since]),
    all("SELECT id FROM senders"),
  ]);
  const m = new Map<number, Health>();
  for (const r of ids) m.set(r.id as number, { sender_id: r.id as number, since: from?.get(r.id as number) && (from.get(r.id as number) as string) > since ? (from.get(r.id as number) as string) : since, sent: 0, bounces: 0, replies: 0, complaints: 0, bounce_rate: null });
  for (const a of acts) {
    const h = m.get(a.sid as number); if (!h || (a.occurred_at as string) < h.since) continue;
    if (a.type === "message") h.sent++; else if (a.outcome === "bounced") h.bounces++; else if (a.outcome === "reply_received") h.replies++;
  }
  for (const c of comps) { const h = m.get(c.sid as number); if (h && (c.occurred_at as string) >= h.since) h.complaints++; }
  for (const h of m.values()) h.bounce_rate = h.sent > 0 ? h.bounces / h.sent : null;
  return m;
}

/**
 * The guard: more than 3% bounces in the last 7 days, or any spam complaint, pauses cold sends for that sender until the Owner resumes it.
 * After a resume only events from the resume onwards count, so one Owner decision is not undone by the same old bounces.
 */
export async function evaluateDeliverability(actor: Actor, senderId: number): Promise<{ paused: boolean; reason?: string }> {
  const { senders } = await loadSenders();
  const s = senders.find((x) => x.id === senderId);
  if (!s || s.paused_at) return { paused: !!s?.paused_at };
  const stats = (await senderStats(s.resumed_at ? new Map([[s.id, s.resumed_at]]) : undefined)).get(s.id)!;
  let why: string | null = null;
  if (stats.complaints > 0) why = `${stats.complaints} spam complaint${stats.complaints > 1 ? "s" : ""} in the last 7 days`;
  else if (stats.bounce_rate !== null && stats.bounce_rate > BOUNCE_LIMIT) why = `7-day bounce rate ${(stats.bounce_rate * 100).toFixed(1)}% (${stats.bounces} of ${stats.sent} sent) is above ${BOUNCE_LIMIT * 100}%`;
  if (!why) return { paused: false };
  const t = now();
  const res = await run("UPDATE senders SET paused_at=?, paused_by=NULL, pause_reason=?, pause_kind='auto', updated_at=? WHERE id=? AND paused_at IS NULL", [t, why, t, s.id]);
  if (!res.changes) return { paused: true };
  await run("INSERT INTO sender_events (sender_id,action,reason,actor_id,actor_name,auto,detail,created_at) VALUES (?,?,?,?,?,1,?,?)", [s.id, "paused", why, actor.id || null, "System (deliverability guard)", JSON.stringify({ triggered_by: actor.name, stats }), t]);
  await audit(actor, "sender_auto_paused", "sender", s.id, { reason: why, stats });
  return { paused: true, reason: why };
}

const complaintSchema = z.object({
  sender_id: z.coerce.number().int().optional(), sender_email: optText(200).optional(),
  lead_id: z.coerce.number().int().nullable().optional(), contact_id: z.coerce.number().int().nullable().optional(),
  message_id: optText(500).optional(), occurred_at: z.string().min(8, "required: ISO time with offset").optional(), note: optText(2000).optional(),
});
/** Records a spam complaint against a sender (idempotent on message_id). It also blocks the contact and may pause the sender. */
export async function recordComplaint(actor: Actor, input: unknown, assertLead: (a: Actor, id: number) => Promise<Row>) {
  const d = parse(complaintSchema, input);
  let sid = await resolveSender({ sender_id: d.sender_id, sender_email: d.sender_email });
  let lead: Row | null = null;
  if (d.lead_id) lead = await assertLead(actor, d.lead_id);
  else if (actor.role !== "owner" && actor.role !== "chief") throw new HttpError(403, "A complaint without a lead can only be recorded by the Owner or a Chief.");
  if (d.contact_id) {
    const c = await one("SELECT * FROM contacts WHERE id=?", [d.contact_id]);
    if (!c) throw new HttpError(400, "contact_id: unknown contact.");
    if (d.lead_id && c.lead_id !== d.lead_id) throw new HttpError(400, "contact_id: not a contact of this lead.");
    if (!lead) lead = await assertLead(actor, c.lead_id as number);
  }
  if (!sid && lead) {
    const r = await one("SELECT COALESCE(sender_id,1) AS s FROM activities WHERE lead_id=? AND type='message' AND outcome='sent' ORDER BY occurred_at DESC,id DESC LIMIT 1", [lead.id as number]);
    sid = (r?.s as number) ?? null;
  }
  if (!sid) throw new HttpError(400, "sender_id (or sender_email, or a lead that was already sent to) is required: the complaint must be charged to a sender.");
  let at = now();
  if (d.occurred_at) { const dt = new Date(d.occurred_at); if (isNaN(+dt)) throw new HttpError(400, "occurred_at: not a valid ISO time."); if (+dt > Date.now() + 300000) throw new HttpError(400, "occurred_at: cannot be in the future."); at = dt.toISOString(); }
  const ext = d.message_id ? `complaint:${sid}:${d.message_id}` : null;
  if (ext) { const dup = await one("SELECT id FROM spam_complaints WHERE external_id=?", [ext]); if (dup) return { duplicate: true, complaint_id: dup.id as number }; }
  const t = now();
  const r = await run("INSERT INTO spam_complaints (sender_id,lead_id,contact_id,message_id,external_id,occurred_at,recorded_by,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [sid, d.lead_id ?? (lead?.id as number) ?? null, d.contact_id ?? null, d.message_id ?? null, ext, at, actor.id, d.note ?? null, t]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  // A spam complaint is an objection: the contact must never be mailed again.
  if (d.contact_id) stmts.push({ sql: "UPDATE contacts SET email_status='opted_out', updated_at=? WHERE id=?", args: [t, d.contact_id] });
  if (lead && d.lead_id) stmts.push({ sql: "INSERT INTO activities (lead_id,contact_id,type,title,body,actor_id,occurred_at,created_at,is_demo,sender_id) VALUES (?,?,'note','Spam complaint',?,?,?,?,?,?)", args: [lead.id as number, d.contact_id ?? null, d.note ?? "Recipient marked the message as spam.", actor.id, at, t, lead.is_demo as number, sid] });
  if (stmts.length) await tx(stmts);
  await audit(actor, "record_spam_complaint", "sender", sid, { complaint_id: r.id, lead_id: d.lead_id ?? null, contact_id: d.contact_id ?? null });
  const guard = await evaluateDeliverability(actor, sid);
  return { duplicate: false, complaint_id: r.id, sender_id: sid, contact_blocked: !!d.contact_id, sender_paused: guard.paused, pause_reason: guard.reason ?? null };
}

/* ---------- health card ---------- */
export async function sendersHealth() {
  const today = todayYmd();
  const from = localMidnight(today).toISOString(), to = localMidnight(addDays(today, 1)).toISOString();
  const [{ senders, steps }, stats, used] = await Promise.all([
    loadSenders(), senderStats(),
    all(`SELECT ${SENDER_OF} AS sid, COUNT(*) AS n FROM activities a LEFT JOIN activities p ON p.id=a.parent_id WHERE a.type='message' AND a.outcome='sent' AND a.is_demo=0 AND a.occurred_precision='time' AND a.occurred_at>=? AND a.occurred_at<? GROUP BY 1`, [from, to]),
  ]);
  const u = new Map(used.map((r) => [r.sid as number, Number(r.n)]));
  return senders.map((s) => {
    const h = stats.get(s.id)!;
    const c = capOn(s, steps.get(s.id), today);
    return {
      sender_id: s.id, email: s.email, display_name: s.display_name, status: statusOn(s, steps.get(s.id), today),
      daily_cap: c.cap, used_today: u.get(s.id) ?? 0, remaining_today: c.cap === null ? null : Math.max(0, c.cap - (u.get(s.id) ?? 0)),
      warmup_not_started: c.not_started, timezone: TZ(),
      sent_7d: h.sent, bounces_7d: h.bounces, bounce_rate_7d: h.bounce_rate, replies_7d: h.replies, complaints_7d: h.complaints,
      paused: s.paused_at ? { at: s.paused_at, kind: s.pause_kind, reason: s.pause_reason } : null,
    };
  });
}
