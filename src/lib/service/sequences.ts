import { z } from "zod";
import type { InValue } from "@libsql/client";
import { all, one, run, now, addDays, todayYmd, localInstant, type Row } from "../db";
import { HttpError, isManager, type Actor } from "../auth";
import { FREE_MAIL, STEP_ACTION, STEP_CODES, STEP_LONG, STEP_SHORT, WORK_ROLES, type WorkRole } from "../constants";
import { audit, parse, parseWhen, optText } from "./common";

/**
 * Follow-up sequences. A sequence is an ordered list of steps for a campaign and channel. A lead that received the first
 * step is ENROLLED; from then on every recorded send marks its step as sent and creates the task for the next one.
 *
 * What this code never does: send, schedule in a mailbox, write a draft, or create an authorization. It creates tasks,
 * due dates and plans only. Every follow-up still needs a draft, the Chief's review, the Owner's send approval and a
 * passing eligibility check.
 */

export const MARKET_GROUPS = ["china", "us", "gulf"] as const;
export type MarketGroup = (typeof MARKET_GROUPS)[number];
export const MARKET_ZONE: Record<MarketGroup, string> = { china: "Asia/Shanghai", us: "America/New_York", gulf: "Asia/Dubai" };
/** 0 = Sunday ... 6 = Saturday. China and the US rest on Saturday and Sunday; the Gulf on Friday and Saturday. */
export const DEFAULT_WEEKENDS: Record<MarketGroup, number[]> = { china: [6, 0], us: [6, 0], gulf: [5, 6] };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------- settings ---------- */
export type SeqSettings = {
  weekends: Record<MarketGroup, number[]>;
  roles: Partial<Record<WorkRole, number>>;
  late_daily_limit: number;
  overdue_days: number;
  plan_buffer: number;
  cutoffs: { hunter: string; writer: string; chief: string; owner: string };
  draft_deadline_time: string;
  reply_sla_hours: number;
  editorial_sla_hours: number;
  not_now_days: number;
  soft_bounce_hold_days: number;
  ooo_max_delay_days: number;
};
const DEFAULTS: SeqSettings = {
  weekends: DEFAULT_WEEKENDS, roles: {}, late_daily_limit: 8, overdue_days: 7, plan_buffer: 0.2,
  cutoffs: { hunter: "14:00", writer: "18:00", chief: "20:00", owner: "22:00" }, draft_deadline_time: "18:00",
  reply_sla_hours: 4, editorial_sla_hours: 24, not_now_days: 90, soft_bounce_hold_days: 3, ooo_max_delay_days: 14,
};
const SETTINGS_KEY = "sequence_settings";
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM (24-hour)");

export async function seqSettings(): Promise<SeqSettings> {
  const r = await one("SELECT value FROM app_settings WHERE key=?", [SETTINGS_KEY]);
  let saved: Partial<SeqSettings> = {};
  try { saved = r?.value ? (JSON.parse(String(r.value)) as Partial<SeqSettings>) : {}; } catch { saved = {}; }
  return { ...DEFAULTS, ...saved, weekends: { ...DEFAULTS.weekends, ...(saved.weekends ?? {}) }, cutoffs: { ...DEFAULTS.cutoffs, ...(saved.cutoffs ?? {}) }, roles: saved.roles ?? {} };
}

const days = z.array(z.coerce.number().int().min(0).max(6)).max(6);
const settingsSchema = z.object({
  weekends: z.object({ china: days.optional(), us: days.optional(), gulf: days.optional() }).optional(),
  roles: z.record(z.string(), z.coerce.number().int().nullable()).optional(),
  late_daily_limit: z.coerce.number().int().min(0).max(500).optional(),
  overdue_days: z.coerce.number().int().min(1).max(60).optional(),
  plan_buffer: z.coerce.number().min(0).max(2).optional(),
  cutoffs: z.object({ hunter: hhmm.optional(), writer: hhmm.optional(), chief: hhmm.optional(), owner: hhmm.optional() }).optional(),
  draft_deadline_time: hhmm.optional(),
  reply_sla_hours: z.coerce.number().int().min(1).max(240).optional(),
  editorial_sla_hours: z.coerce.number().int().min(1).max(240).optional(),
  not_now_days: z.coerce.number().int().min(1).max(730).optional(),
});
export async function setSeqSettings(actor: Actor, input: unknown) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change the follow-up settings.");
  const d = parse(settingsSchema, input);
  const before = await seqSettings();
  const roles: Partial<Record<WorkRole, number>> = { ...before.roles };
  for (const [k, v] of Object.entries(d.roles ?? {})) {
    if (!(WORK_ROLES as readonly string[]).includes(k)) throw new HttpError(400, `roles: unknown role "${k}". One of ${WORK_ROLES.join(", ")}.`);
    if (v == null) delete roles[k as WorkRole];
    else {
      if (!(await one("SELECT id FROM users WHERE id=? AND active=1", [v]))) throw new HttpError(400, `roles.${k}: unknown or disabled user.`);
      roles[k as WorkRole] = v;
    }
  }
  const { roles: _r, weekends, cutoffs, ...rest } = d;
  void _r;
  const next: SeqSettings = { ...before, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), roles,
    weekends: { ...before.weekends, ...Object.fromEntries(Object.entries(weekends ?? {}).filter(([, v]) => v)) } as SeqSettings["weekends"],
    cutoffs: { ...before.cutoffs, ...Object.fromEntries(Object.entries(cutoffs ?? {}).filter(([, v]) => v)) } as SeqSettings["cutoffs"] };
  await run("INSERT INTO app_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [SETTINGS_KEY, JSON.stringify(next), actor.id, now()]);
  await audit(actor, "sequence_settings_changed", "setting", 0, { from: before, to: next });
  return next;
}

/** Who does each kind of work. The Owner's mapping wins; otherwise the user whose name says so; otherwise a Chief, then the Owner. */
export async function roleUsers(settings?: SeqSettings): Promise<Record<WorkRole, number | null>> {
  const s = settings ?? (await seqSettings());
  const users = await all("SELECT id,name,role,preset FROM users WHERE active=1 ORDER BY id");
  const byName = (re: RegExp) => (users.find((u) => re.test(String(u.name))) ?.id as number | undefined) ?? null;
  const chief = (users.find((u) => u.role === "chief")?.id as number | undefined) ?? null;
  const owner = (users.find((u) => u.role === "owner")?.id as number | undefined) ?? null;
  const ok = (id: number | undefined) => (id && users.some((u) => u.id === id) ? id : null);
  const fb = chief ?? owner;
  return {
    writer: ok(s.roles.writer) ?? byName(/writer/i) ?? fb, hunter: ok(s.roles.hunter) ?? byName(/hunter|research/i) ?? fb,
    inbox: ok(s.roles.inbox) ?? byName(/inbox/i) ?? fb, linkedin: ok(s.roles.linkedin) ?? byName(/linkedin/i) ?? fb,
    chief: ok(s.roles.chief) ?? fb, owner: ok(s.roles.owner) ?? owner,
    compliance: ok(s.roles.compliance) ?? ((users.find((u) => u.preset === "compliance")?.id as number | undefined) ?? byName(/quality|compliance/i)),
  };
}
/** The work role of a person: mapped by the Owner, or read from their name. Owner and Chiefs are their own roles. */
export async function roleOf(actor: Actor): Promise<WorkRole | null> {
  if (actor.role === "owner") return "owner";
  if (actor.role === "chief") return "chief";
  if (actor.perms.has("compliance.view")) return "compliance";
  const map = await roleUsers();
  return (["writer", "hunter", "inbox", "linkedin"] as WorkRole[]).find((r) => map[r] === actor.id) ?? null;
}

/* ---------- dates ---------- */
const dow = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
export const dayName = (ymd: string) => DAY_NAMES[dow(ymd)];
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
export function nextWorkday(ymd: string, weekend: number[]): { ymd: string; shift: number } {
  let d = ymd, shift = 0;
  while (weekend.includes(dow(d)) && shift < 7) { d = addDays(d, 1); shift++; }
  return { ymd: d, shift };
}
function addWorkdays(ymd: string, n: number, weekend: number[]) {
  let d = ymd;
  for (let i = 0; i < n; ) { d = addDays(d, 1); if (!weekend.includes(dow(d))) i++; }
  return d;
}
export const marketOfCampaign = (c: { key?: unknown; name?: unknown } | null | undefined, lead: { market?: unknown; country?: unknown }): MarketGroup => {
  const k = `${c?.key ?? ""} ${c?.name ?? ""}`.toLowerCase();
  if (/canton|china/.test(k)) return "china";
  if (/gulf/.test(k)) return "gulf";
  if (/(^|[\s_])us([\s_]|$)|united states|america/.test(k)) return "us";
  const m = String(lead.market ?? "").toLowerCase(), co = String(lead.country ?? "").toLowerCase();
  if (m === "china" || /china|hong kong/.test(co)) return "china";
  if (["uae", "ksa", "qatar", "kuwait", "bahrain", "oman", "gulf"].includes(m) || /emirates|uae|saudi|qatar|kuwait|bahrain|oman/.test(co)) return "gulf";
  return "us";
};
/** The calendar day a send happened on, read in the prospect's market zone (a day-only historical date stays that day). */
const sentDay = (iso: string, precision: string | null | undefined, group: MarketGroup) => todayYmd(precision === "day" ? undefined : MARKET_ZONE[group], new Date(iso));

/** Due date and last day of the window for one step. A due day on a weekend moves to the next working day and the window moves with it. */
export function planStep(step: Row, firstOn: string, prevOn: string | null, weekend: number[], business = false) {
  const base = step.anchor === "previous" ? prevOn ?? firstOn : firstOn;
  const add = (n: number) => (business ? addWorkdays(base, n, weekend) : addDays(base, n));
  const len = Math.max(0, Number(step.offset_end) - Number(step.offset_start));
  let due = add(Number(step.offset_start)), end = add(Number(step.offset_end));
  if (step.min_gap_prev != null && prevOn) {
    const min = addDays(prevOn, Number(step.min_gap_prev));
    if (min > due) { due = min; end = addDays(min, len); }
  }
  const w = nextWorkday(due, weekend);
  return { due_on: w.ymd, window_end_on: addDays(end < due ? due : end, w.shift) };
}

/* ---------- sequences: read and edit ---------- */
export async function listSequences() {
  const [seqs, steps, counts] = await Promise.all([
    all("SELECT s.*, c.name AS campaign, c.key AS campaign_key FROM sequences s LEFT JOIN campaigns c ON c.id=s.campaign_id ORDER BY (s.campaign_id IS NULL), s.channel, s.id"),
    all("SELECT * FROM sequence_steps ORDER BY sequence_id, version, position"),
    all("SELECT sequence_id, status, COUNT(*) AS n FROM enrollments GROUP BY sequence_id, status"),
  ]);
  const settings = await seqSettings();
  return seqs.map((s) => {
    const mine = steps.filter((x) => x.sequence_id === s.id && x.version === s.version);
    const group = marketOfCampaign({ key: s.campaign_key, name: s.campaign }, { market: s.market });
    return { ...s, market_group: group, weekend_days: settings.weekends[group].map((d) => DAY_NAMES[d]), steps: mine,
      enrolled: Object.fromEntries(counts.filter((c) => c.sequence_id === s.id).map((c) => [c.status as string, Number(c.n)])),
      preview: previewText(mine, settings.weekends[group], s.day_mode === "business") };
  });
}
export async function getSequence(id: number) {
  const s = (await listSequences()).find((x) => (x as Row).id === id);
  if (!s) throw new HttpError(404, "Sequence not found.");
  return s;
}
/** "Email 1 sent Mon 16 Nov -> FU1 due Fri 20 Nov, FU2 due Fri 27 Nov": the next Monday as the example day. */
function previewText(steps: Row[], weekend: number[], business: boolean) {
  let start = todayYmd();
  while (dow(start) !== 1) start = addDays(start, 1);
  const f = (ymd: string) => `${dayName(ymd)} ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${ymd}T00:00:00Z`))}`;
  const parts: string[] = [];
  let prev = start;
  for (const st of steps.filter((x) => x.active)) {
    if (st.position === 1) { parts.push(`${STEP_SHORT[st.step_code as string] ?? st.step_code} sent ${f(start)}`); continue; }
    const p = planStep(st, start, prev, weekend, business);
    parts.push(`${STEP_SHORT[st.step_code as string] ?? st.step_code} due ${f(p.due_on)} (window to ${f(p.window_end_on)})`);
    prev = p.due_on;
  }
  return parts.join(" → ");
}

const stepSchema = z.object({
  step_code: z.enum(STEP_CODES), anchor: z.enum(["first", "previous", "condition"]).default("first"),
  offset_start: z.coerce.number().int().min(0).max(365), offset_end: z.coerce.number().int().min(0).max(365),
  min_gap_prev: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(0).max(365).nullable()).optional(),
  thread_reply: z.coerce.boolean().optional(), assignee_role: z.enum(WORK_ROLES).optional(), active: z.coerce.boolean().optional(),
});
const seqSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(), status: z.enum(["draft", "active", "retired"]).optional(), day_mode: z.enum(["calendar", "business"]).optional(),
  rest_days: z.coerce.number().int().min(0).max(730).optional(), max_touches: z.coerce.number().int().min(1).max(20).optional(), min_days_between: z.coerce.number().int().min(0).max(60).optional(),
  end_action: z.enum(["rest", "close", "review", "stop"]).optional(), auto_enroll: z.coerce.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(12).optional(), reason: optText(500).optional(),
});
/** Owner only. Saving steps creates a new version; leads already enrolled keep the version they started with. */
export async function updateSequence(actor: Actor, id: number, input: unknown) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change a follow-up sequence.");
  const d = parse(seqSchema, input);
  const s = await one("SELECT * FROM sequences WHERE id=?", [id]);
  if (!s) throw new HttpError(404, "Sequence not found.");
  const t = now();
  let version = s.version as number;
  if (d.steps) {
    for (const [i, st] of d.steps.entries()) if (st.offset_end < st.offset_start) throw new HttpError(400, `steps.${i}.offset_end: the window cannot end before it starts.`);
    version++;
    for (const [i, st] of d.steps.entries())
      await run("INSERT INTO sequence_steps (sequence_id,version,position,step_code,anchor,offset_start,offset_end,min_gap_prev,thread_reply,assignee_role,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [id, version, i + 1, st.step_code, i === 0 && st.anchor === "previous" ? "first" : st.anchor, st.offset_start, st.offset_end, st.min_gap_prev ?? null, st.thread_reply === false ? 0 : i === 0 ? 0 : 1, st.assignee_role ?? (s.channel === "linkedin" ? "linkedin" : "writer"), st.active === false ? 0 : 1]);
  }
  const sets: string[] = ["version=?", "updated_by=?", "updated_at=?"];
  const args: InValue[] = [version, actor.id, t];
  for (const k of ["name", "status", "day_mode", "rest_days", "max_touches", "min_days_between", "end_action"] as const) if (d[k] !== undefined) (sets.push(`${k}=?`), args.push(d[k] as InValue));
  if (d.auto_enroll !== undefined) (sets.push("auto_enroll=?"), args.push(d.auto_enroll ? 1 : 0));
  await run(`UPDATE sequences SET ${sets.join(",")} WHERE id=?`, [...args, id]);
  const running = Number((await one("SELECT COUNT(*) AS n FROM enrollments WHERE sequence_id=? AND status IN ('running','paused')", [id]))!.n);
  await audit(actor, "sequence_settings_changed", "sequence", id, { reason: d.reason ?? null, from_version: s.version, to_version: version, changed: Object.keys(d).filter((k) => k !== "reason"), running_enrollments_keep_their_version: running });
  return { ...(await getSequence(id)), running_enrollments: running, note: version !== s.version ? `Version ${version} applies to leads enrolled from now on. ${running} running lead${running === 1 ? "" : "s"} keep version ${s.version}.` : undefined };
}
export async function sequenceLog(limit = 100) {
  return all("SELECT id,actor_name,action,entity,entity_id,detail,created_at FROM audit_log WHERE action='sequence_settings_changed' ORDER BY id DESC LIMIT ?", [Math.min(Math.max(limit, 1), 500)]);
}

/* ---------- the plan for one lead and channel ---------- */
type Ctx = { settings: SeqSettings; sequences: Row[]; steps: Row[]; campaigns: Map<number, Row> };
async function loadCtx(): Promise<Ctx> {
  const [settings, sequences, steps, camps] = await Promise.all([seqSettings(), all("SELECT * FROM sequences WHERE status='active'"), all("SELECT * FROM sequence_steps WHERE active=1 ORDER BY sequence_id,version,position"), all("SELECT id,key,name,status FROM campaigns")]);
  return { settings, sequences, steps, campaigns: new Map(camps.map((c) => [c.id as number, c])) };
}
function resolveSequence(ctx: Ctx, campaignId: number | null, channel: string, market: string | null): Row | null {
  const pool = ctx.sequences.filter((s) => s.channel === channel);
  return pool.find((s) => campaignId && s.campaign_id === campaignId && s.market && s.market === market)
    ?? pool.find((s) => campaignId && s.campaign_id === campaignId && !s.market)
    ?? pool.find((s) => !s.campaign_id && !s.market) ?? null;
}
const SENDS_SQL = (marks: string) => `SELECT a.id,a.lead_id,a.occurred_at,a.occurred_precision,a.contact_id,COALESCE(a.sender_id,1) AS sender_id,a.title,a.message_kind,a.task_id,COALESCE(a.channel,'email') AS channel,
  (SELECT e.campaign_id FROM send_events e WHERE e.activity_id=a.id LIMIT 1) AS campaign_id, (SELECT e.message_version_id FROM send_events e WHERE e.activity_id=a.id LIMIT 1) AS message_version_id
  FROM activities a WHERE a.lead_id IN (${marks}) AND a.type='message' AND a.outcome='sent' AND a.occurred_precision<>'unknown'
    AND NOT (COALESCE(a.channel,'email')='linkedin' AND lower(COALESCE(a.title,'')) LIKE '%connect%') ORDER BY a.occurred_at, a.id`;

export type StepPlan = { position: number; code: string; due_on: string; window_end_on: string; late: boolean; days_late: number };
export type LeadPlan = {
  lead_id: number; company: string; channel: string; campaign_id: number | null; campaign: string | null; no_campaign: boolean;
  sequence_id: number; sequence: string; sequence_version: number; market_group: MarketGroup; sender_id: number | null; contact_id: number | null;
  thread_subject: string | null; sent: { position: number; code: string; sent_at: string; activity_id: number; message_version_id: number | null; subject: string | null }[];
  step_total: number; next: StepPlan | null; rest_until: string | null; end_action: string; action: string;
};

function buildPlan(ctx: Ctx, lead: Row, channel: string, sends: Row[], memberships: number[], opts: { acceptOn?: string | null; version?: number; sequenceId?: number } = {}): LeadPlan | null {
  const mine = sends.filter((s) => s.channel === channel);
  const campaignId = (mine.find((s) => s.campaign_id)?.campaign_id as number | undefined) ?? (memberships.length ? memberships[memberships.length - 1] : null);
  const camp = campaignId ? ctx.campaigns.get(campaignId) ?? null : null;
  const seq = opts.sequenceId ? ctx.sequences.find((s) => s.id === opts.sequenceId) ?? null : resolveSequence(ctx, campaignId, channel, (lead.market as string) ?? null);
  if (!seq) return null;
  const version = opts.version ?? (seq.version as number);
  const steps = ctx.steps.filter((s) => s.sequence_id === seq.id && s.version === version);
  if (!steps.length) return null;
  const group = marketOfCampaign(camp, lead);
  const weekend = ctx.settings.weekends[group];
  const today = todayYmd();
  const sent = mine.slice(0, steps.length).map((s, i) => ({ position: steps[i].position as number, code: steps[i].step_code as string, sent_at: s.occurred_at as string, activity_id: s.id as number, message_version_id: (s.message_version_id as number) ?? null, subject: (s.title as string) ?? null, precision: s.occurred_precision as string }));
  const first = sent[0];
  const firstOn = first ? sentDay(first.sent_at, first.precision, group) : opts.acceptOn ?? null;
  const last = sent[sent.length - 1];
  const prevOn = last ? sentDay(last.sent_at, last.precision, group) : opts.acceptOn ?? null;
  const nextStep = steps[sent.length];
  let next: StepPlan | null = null;
  if (nextStep && firstOn && (sent.length > 0 || nextStep.anchor === "condition")) {
    const p = planStep(nextStep, firstOn, prevOn, weekend, seq.day_mode === "business");
    const late = p.window_end_on < today;
    next = { position: nextStep.position as number, code: nextStep.step_code as string, ...p, late, days_late: Math.max(0, diffDays(today, p.due_on)) };
  }
  const rest = !nextStep && last ? addDays(sentDay(last.sent_at, last.precision, group), Number(seq.rest_days)) : null;
  const action = next ? (next.late ? `Late ${STEP_SHORT[next.code] ?? next.code} on the original thread (label LATE)` : next.due_on <= today ? `${STEP_SHORT[next.code] ?? next.code} is due now` : `${STEP_SHORT[next.code] ?? next.code} planned`)
    : rest ? (seq.end_action === "stop" ? "Sequence finished" : `Rest until ${rest}`) : "Nothing to plan yet";
  return {
    lead_id: lead.id as number, company: lead.company as string, channel, campaign_id: campaignId, campaign: (camp?.name as string) ?? null, no_campaign: !campaignId,
    sequence_id: seq.id as number, sequence: seq.name as string, sequence_version: version, market_group: group, sender_id: (first ? (mine[0].sender_id as number) : null), contact_id: (mine[0]?.contact_id as number) ?? null,
    thread_subject: first?.subject ? String(first.subject).replace(/^\s*(re|fwd?)\s*:\s*/i, "") : null,
    sent: sent.map(({ precision: _p, ...x }) => (void _p, x)), step_total: steps.length, next, rest_until: rest, end_action: seq.end_action as string, action,
  };
}

/** Why no further step may be planned for this lead right now (null = nothing stands in the way). */
async function blockReason(lead: Row, channel: string): Promise<string | null> {
  if (lead.historical_only) return "historical-only";
  const flag = await one("SELECT flag FROM lists WHERE kind='stage' AND key=?", [lead.stage as string]);
  if (["won", "lost", "closed"].includes(String(flag?.flag ?? ""))) return `stage ${lead.stage}`;
  if (await one("SELECT 1 AS x FROM activities WHERE lead_id=? AND type='reply' LIMIT 1", [lead.id as number])) return "reply";
  const cs = await all("SELECT email,email_status,is_invalid FROM contacts WHERE lead_id=?", [lead.id as number]);
  if (cs.some((c) => c.email_status === "opted_out")) return "opt-out";
  if (channel === "email" && cs.length && cs.every((c) => c.email_status === "bounced" || c.is_invalid || !c.email)) return "bounce";
  return null;
}

const firstWord = (s: unknown) => String(s ?? "").trim().split(/\s+/)[0] ?? "";
const shortCompany = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(8, max - 1)).trimEnd()}…` : s);
/** "FU1 · Jay's Used Cars · Wisam": the short title every automatic task is created with. */
export const shortTitle = (type: string, company: string | null, who: string | null) => {
  const tail = who ? ` · ${who}` : "";
  const room = 60 - type.length - tail.length - 3;
  return company ? `${type} · ${shortCompany(company, Math.max(12, room))}${tail}` : `${type}${tail}`;
};
const endOfDay = (ymd: string) => parseWhen(ymd) as string;

export type SyncResult = { enrolled: boolean; enrollment_id: number | null; status: string | null; steps_sent: number; next_task_id: number | null; next_step: StepPlan | null; rest_until: string | null; created: boolean; note?: string };

/**
 * Brings one lead's enrollment in line with what was really sent, and makes sure the next step has its task.
 * Safe to call any number of times: a step exists once (UNIQUE enrollment + position) and its task is claimed before it is created.
 */
export async function syncEnrollment(actor: Actor, leadId: number, channel: string, opts: { ctx?: Ctx; acceptOn?: string | null; backfill?: boolean; allowCreate?: boolean } = {}): Promise<SyncResult> {
  const none: SyncResult = { enrolled: false, enrollment_id: null, status: null, steps_sent: 0, next_task_id: null, next_step: null, rest_until: null, created: false };
  const lead = await one("SELECT * FROM leads WHERE id=?", [leadId]);
  if (!lead) return none;
  const ctx = opts.ctx ?? (await loadCtx());
  let enr = await one("SELECT * FROM enrollments WHERE lead_id=? AND channel=?", [leadId, channel]);
  if (enr && enr.status !== "running") return { ...none, enrolled: true, enrollment_id: enr.id as number, status: enr.status as string, steps_sent: Number(enr.steps_sent), rest_until: (enr.rest_until as string) ?? null, note: `The sequence is ${enr.status}${enr.stop_reason ? ` (${enr.stop_reason})` : ""}; nothing was planned.` };
  const [sends, mem] = await Promise.all([all(SENDS_SQL("?"), [leadId]), all("SELECT campaign_id FROM lead_campaigns WHERE lead_id=? AND status='active' ORDER BY id", [leadId])]);
  const acceptOn = opts.acceptOn ?? (enr?.anchor_on as string | null) ?? null;
  const plan = buildPlan(ctx, lead, channel, sends, mem.map((m) => m.campaign_id as number), { acceptOn, version: enr ? (enr.sequence_version as number) : undefined, sequenceId: enr ? (enr.sequence_id as number) : undefined });
  if (!plan || (!plan.sent.length && !acceptOn)) return none;
  const t = now();
  let created = false;
  if (!enr) {
    if (opts.allowCreate === false) return none;
    const seq = ctx.sequences.find((s) => s.id === plan.sequence_id)!;
    if (!seq.auto_enroll && !opts.backfill) return { ...none, note: "Automatic enrollment is switched off for this sequence." };
    if (lead.historical_only) return none;
    // The experiment labels come from the first step: its task, else its message version.
    const e1 = plan.sent[0];
    const lab = e1 ? await one("SELECT COALESCE((SELECT t.labels FROM tasks t JOIN activities a ON a.task_id=t.id WHERE a.id=? AND t.labels IS NOT NULL), (SELECT v.labels FROM message_versions v WHERE v.id=?)) AS labels", [e1.activity_id, e1.message_version_id ?? 0]) : null;
    await run(`INSERT OR IGNORE INTO enrollments (lead_id,contact_id,sequence_id,sequence_version,campaign_id,channel,market_group,status,sender_id,thread_subject,labels,anchor_on,backfilled,created_by,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?)`,
      [leadId, plan.contact_id, plan.sequence_id, plan.sequence_version, plan.campaign_id, channel, plan.market_group, plan.sender_id, plan.thread_subject, (lab?.labels as string) ?? null, acceptOn, opts.backfill ? 1 : 0, actor.id || null, t, t]);
    enr = (await one("SELECT * FROM enrollments WHERE lead_id=? AND channel=?", [leadId, channel]))!;
    created = true;
    await audit(actor, "sequence_enrolled", "lead", leadId, { enrollment_id: enr.id, sequence_id: plan.sequence_id, version: plan.sequence_version, channel, backfill: !!opts.backfill });
  }
  const eid = enr.id as number;
  const labels = (enr.labels as string | null) ?? null;
  // 1. Every send found in the history marks its step as sent (once).
  for (const s of plan.sent) {
    await run("INSERT OR IGNORE INTO enrollment_steps (enrollment_id,position,step_code,status,created_at,updated_at) VALUES (?,?,?,'planned',?,?)", [eid, s.position, s.code, t, t]);
    const row = (await one("SELECT * FROM enrollment_steps WHERE enrollment_id=? AND position=?", [eid, s.position]))!;
    if (row.status === "sent") continue;
    await run("UPDATE enrollment_steps SET status='sent', sent_at=?, activity_id=?, message_version_id=?, subject=?, updated_at=? WHERE id=?", [s.sent_at, s.activity_id, s.message_version_id, s.subject, t, row.id as number]);
    await run("UPDATE activities SET step_code=COALESCE(step_code,?), labels=COALESCE(labels,?) WHERE id=?", [s.code, labels, s.activity_id]);
    // A send recorded without its task (by hand, or sent from the mailbox directly) still closes that step's task.
    if (row.task_id && Number(row.task_id) > 0) {
      const done = await run("UPDATE tasks SET status='completed', completed_at=?, completed_by=?, completion_note=?, activity_id=COALESCE(activity_id,?), sent_at=COALESCE(sent_at,?), blockers=NULL, updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')",
        [t, actor.id || null, `Auto-completed: send recorded (activity ${s.activity_id})`, s.activity_id, s.sent_at, t, row.task_id as number]);
      if (done.changes) await audit(actor, "task_auto_complete", "task", row.task_id as number, { activity_id: s.activity_id, enrollment_id: eid });
    }
  }
  const lastSent = plan.sent[plan.sent.length - 1];
  await run("UPDATE enrollments SET steps_sent=?, last_step_code=?, first_sent_at=?, last_sent_at=?, sender_id=COALESCE(sender_id,?), thread_subject=COALESCE(thread_subject,?), campaign_id=COALESCE(campaign_id,?), updated_at=? WHERE id=?",
    [plan.sent.length, lastSent?.code ?? null, plan.sent[0]?.sent_at ?? null, lastSent?.sent_at ?? null, plan.sender_id, plan.thread_subject, plan.campaign_id, t, eid]);

  // 2. No step left: rest (or finish).
  if (!plan.next) {
    if (!plan.rest_until) return { ...none, enrolled: true, enrollment_id: eid, status: "running", steps_sent: plan.sent.length, created };
    const status = plan.end_action === "stop" || plan.end_action === "close" ? "completed" : "resting";
    await run("UPDATE enrollments SET status=?, stop_reason=?, rest_until=?, next_due_on=NULL, updated_at=? WHERE id=?", [status, status === "completed" ? "sequence finished" : null, status === "resting" ? plan.rest_until : null, t, eid]);
    await audit(actor, "sequence_completed", "lead", leadId, { enrollment_id: eid, status, rest_until: status === "resting" ? plan.rest_until : null });
    return { enrolled: true, enrollment_id: eid, status, steps_sent: plan.sent.length, next_task_id: null, next_step: null, rest_until: status === "resting" ? plan.rest_until : null, created };
  }

  // 3. The next step and its task.
  const why = await blockReason(lead, channel);
  if (why) {
    await run("UPDATE enrollments SET status='stopped', stop_reason=?, next_due_on=NULL, updated_at=? WHERE id=?", [why, t, eid]);
    await audit(actor, "sequence_stopped", "lead", leadId, { enrollment_id: eid, reason: why });
    return { enrolled: true, enrollment_id: eid, status: "stopped", steps_sent: plan.sent.length, next_task_id: null, next_step: null, rest_until: null, created, note: `No next step was planned: ${why}.` };
  }
  const nx = plan.next;
  await run("INSERT OR IGNORE INTO enrollment_steps (enrollment_id,position,step_code,status,due_on,window_end_on,late,created_at,updated_at) VALUES (?,?,?,'planned',?,?,?,?,?)", [eid, nx.position, nx.code, nx.due_on, nx.window_end_on, nx.late ? 1 : 0, t, t]);
  const stepRow = (await one("SELECT * FROM enrollment_steps WHERE enrollment_id=? AND position=?", [eid, nx.position]))!;
  await run("UPDATE enrollments SET next_due_on=?, updated_at=? WHERE id=?", [stepRow.due_on as string, t, eid]);
  let taskId = stepRow.task_id && Number(stepRow.task_id) > 0 ? (stepRow.task_id as number) : null;
  if (!taskId && stepRow.status === "planned" && (await run("UPDATE enrollment_steps SET task_id=-1 WHERE id=? AND task_id IS NULL", [stepRow.id as number])).changes) {
    taskId = await createStepTask(actor, ctx, lead, enr, plan, { ...nx, due_on: stepRow.due_on as string, window_end_on: stepRow.window_end_on as string, late: !!stepRow.late });
    await run("UPDATE enrollment_steps SET task_id=? WHERE id=?", [taskId, stepRow.id as number]);
  }
  return { enrolled: true, enrollment_id: eid, status: "running", steps_sent: plan.sent.length, next_task_id: taskId, next_step: { ...nx, due_on: stepRow.due_on as string, window_end_on: stepRow.window_end_on as string }, rest_until: null, created };
}

async function createStepTask(actor: Actor, ctx: Ctx, lead: Row, enr: Row, plan: LeadPlan, nx: StepPlan): Promise<number> {
  const t = now();
  const step = ctx.steps.find((s) => s.sequence_id === plan.sequence_id && s.version === plan.sequence_version && s.position === nx.position);
  const roles = await roleUsers(ctx.settings);
  const assignee = roles[(step?.assignee_role as WorkRole) ?? "writer"] ?? roles.chief ?? roles.owner ?? actor.id;
  const sender = plan.sender_id ? await one("SELECT id,email,display_name FROM senders WHERE id=?", [plan.sender_id]) : null;
  const action = STEP_ACTION[nx.code] ?? "other";
  let labels: string[] = [];
  try { labels = enr.labels ? (JSON.parse(String(enr.labels)) as string[]) : []; } catch { labels = []; }
  if (nx.late && !labels.includes("LATE")) labels = [...labels, "LATE"];
  const subject = step?.thread_reply && plan.thread_subject ? `Re: ${plan.thread_subject}` : null;
  // An open task for the same step that someone created by hand is adopted, never duplicated.
  const existing = await one("SELECT id FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND enrollment_id IS NULL AND action_type=? ORDER BY id LIMIT 1", [lead.id as number, action]);
  const today = todayYmd();
  const dl = nx.due_on > today ? addDays(nx.due_on, -1) : today;
  const [dh, dm] = ctx.settings.draft_deadline_time.split(":").map(Number);
  const draftDeadline = new Date(localInstant(dl, dh, dm).instant).toISOString();
  const fields: InValue[] = [enr.id as number, nx.code, nx.position, plan.step_total, nx.window_end_on, draftDeadline, labels.length ? JSON.stringify(labels) : null, plan.sender_id, subject, nx.late ? 1 : 0];
  if (existing) {
    await run("UPDATE tasks SET enrollment_id=?, step_code=?, step_number=?, step_total=?, window_end_on=?, draft_deadline=?, labels=COALESCE(labels,?), sender_id=COALESCE(sender_id,?), thread_subject=?, is_late=?, due_at=COALESCE(due_at,?), due_on=COALESCE(due_on,?), campaign_id=COALESCE(campaign_id,?), channel=COALESCE(channel,?), updated_at=? WHERE id=?",
      [...fields, endOfDay(nx.due_on), nx.due_on, plan.campaign_id, plan.channel, t, existing.id as number]);
    await audit(actor, "sequence_task_adopted", "task", existing.id as number, { lead_id: lead.id, enrollment_id: enr.id, step: nx.code });
    return existing.id as number;
  }
  const who = sender ? firstWord(sender.display_name) : null;
  const title = shortTitle(STEP_SHORT[nx.code] ?? nx.code, lead.company as string, who);
  const lines = [
    `Step ${nx.position} of ${plan.step_total} (${plan.sequence}).`,
    subject ? `Reply in the same thread, subject "${subject}"${sender ? `, from ${sender.email}` : ""}.` : sender ? `Send from ${sender.email}.` : null,
    `Due ${nx.due_on}, window to ${nx.window_end_on}.`,
    nx.late ? "LATE: the window had already passed when this step was planned. It is labelled LATE and left out of experiment comparisons." : null,
    plan.no_campaign ? "This lead is in no campaign. Add it to a campaign before drafting." : null,
    "Created automatically. It needs a draft, the Chief's review and the Owner's send approval like any other message.",
  ].filter(Boolean).join(" ");
  const r = await run(
    `INSERT INTO tasks (lead_id,assignee_id,created_by,title,instructions,task_type,approval_from,due_at,due_on,is_demo,created_at,updated_at,channel,action_type,prep_status,blockers,campaign_id,
       enrollment_id,step_code,step_number,step_total,window_end_on,draft_deadline,labels,sender_id,thread_subject,is_late,auto_generated)
     VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,'draft_needed',?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [lead.id as number, assignee, actor.id || assignee, title, lines, endOfDay(nx.due_on), nx.due_on, lead.is_demo as number, t, t, plan.channel, action, plan.no_campaign ? "The lead is in no campaign yet." : null, plan.campaign_id, ...fields]);
  await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [lead.id as number, r.id, `Task created: ${title}`, `Planned automatically by the follow-up sequence (step ${nx.position} of ${plan.step_total}).`, actor.id || null, t, t, lead.is_demo as number]);
  await audit(actor, "sequence_task_created", "task", r.id, { lead_id: lead.id, enrollment_id: enr.id, step: nx.code, step_number: nx.position, step_total: plan.step_total, due_on: nx.due_on, window_end_on: nx.window_end_on, late: nx.late, assignee_id: assignee });
  return r.id;
}

/** Called after any recorded send. Never throws: a planning problem must not undo or hide a recorded send. */
export async function afterSend(actor: Actor, leadId: number, channel: string | null): Promise<SyncResult | null> {
  try { return await syncEnrollment(actor, leadId, channel || "email"); }
  catch (e) { console.error("sequence sync failed", e); return null; }
}

/* ---------- stopping, pausing, resuming ---------- */
export type StopEffects = { sequences_stopped: number[]; tasks_cancelled: number[]; send_authorizations_revoked: number };
/** Stops (or rests) a lead's running sequences, cancels their pending step tasks and withdraws the send approvals of those drafts. */
export async function stopSequences(actor: Actor, leadId: number, reason: string, o: { status?: "stopped" | "resting"; restUntil?: string | null; channels?: string[]; revokeAll?: boolean } = {}): Promise<StopEffects> {
  const t = now();
  const enrs = (await all("SELECT * FROM enrollments WHERE lead_id=? AND status IN ('running','paused')", [leadId])).filter((e) => !o.channels || o.channels.includes(e.channel as string));
  const lead = (await one("SELECT is_demo FROM leads WHERE id=?", [leadId]))!;
  const pend = await all(`SELECT id,title,message_version_id FROM tasks WHERE lead_id=? AND status NOT IN ('completed','cancelled') AND (enrollment_id IS NOT NULL OR action_type LIKE '%follow%' COLLATE NOCASE)${o.channels ? ` AND COALESCE(channel,'email') IN (${o.channels.map(() => "?").join(",")})` : ""}`, [leadId, ...(o.channels ?? [])]);
  let revoked = 0;
  for (const tk of pend) {
    await run("UPDATE tasks SET status='cancelled', blockers=NULL, completion_note=?, updated_at=? WHERE id=?", [`Cancelled automatically: ${reason}`, t, tk.id as number]);
    await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [leadId, tk.id as number, `Task cancelled: ${tk.title}`, reason, actor.id || null, t, t, lead.is_demo as number]);
    await run("UPDATE enrollment_steps SET status='cancelled', note=?, updated_at=? WHERE task_id=? AND status='planned'", [reason, t, tk.id as number]);
    if (tk.message_version_id && !o.revokeAll) revoked += (await run("UPDATE send_authorizations SET status='revoked' WHERE status='active' AND kind='send' AND message_version_id IN (SELECT v2.id FROM message_versions v1 JOIN message_versions v2 ON v2.lead_id=v1.lead_id AND COALESCE(v2.contact_id,0)=COALESCE(v1.contact_id,0) AND v2.channel=v1.channel AND v2.campaign_id=v1.campaign_id WHERE v1.id=?)", [tk.message_version_id as number])).changes;
    await audit(actor, "task_auto_cancel", "task", tk.id as number, { reason, lead_id: leadId });
  }
  if (o.revokeAll) revoked += (await run("UPDATE send_authorizations SET status='revoked' WHERE lead_id=? AND kind='send' AND status='active'", [leadId])).changes;
  for (const e of enrs) {
    await run("UPDATE enrollments SET status=?, stop_reason=?, rest_until=?, next_due_on=NULL, updated_at=? WHERE id=?", [o.status ?? "stopped", reason, o.restUntil ?? null, t, e.id as number]);
    await audit(actor, "sequence_stopped", "lead", leadId, { enrollment_id: e.id, reason, status: o.status ?? "stopped", rest_until: o.restUntil ?? null });
  }
  return { sequences_stopped: enrs.map((e) => e.id as number), tasks_cancelled: pend.map((p) => p.id as number), send_authorizations_revoked: revoked };
}

const controlSchema = z.object({ action: z.enum(["pause", "resume", "stop"]), reason: z.string().trim().min(3, "reason: say why").max(500), channel: z.string().optional(), resume_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
/** Owner and Chief: pause, resume or stop a lead's sequence by hand. Every action is written to the change history. */
export async function controlSequence(actor: Actor, leadId: number, input: unknown) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or a Chief can pause, resume or stop a sequence.");
  const d = parse(controlSchema, input);
  const enr = await one(`SELECT * FROM enrollments WHERE lead_id=?${d.channel ? " AND channel=?" : ""} ORDER BY (status='running') DESC, id DESC LIMIT 1`, d.channel ? [leadId, d.channel] : [leadId]);
  if (!enr) throw new HttpError(404, "This lead is not in a sequence.");
  const t = now();
  if (d.action === "stop") {
    if (!["running", "paused"].includes(enr.status as string)) throw new HttpError(409, `The sequence is already ${enr.status}.`);
    return { action: "stop", ...(await stopSequences(actor, leadId, `stopped by ${actor.name}: ${d.reason}`, { channels: [enr.channel as string] })) };
  }
  if (d.action === "pause") {
    if (enr.status !== "running") throw new HttpError(409, `Only a running sequence can be paused (it is ${enr.status}).`);
    await run("UPDATE enrollments SET status='paused', stop_reason=?, paused_until=?, updated_at=? WHERE id=?", [d.reason, d.resume_on ?? null, t, enr.id as number]);
    await audit(actor, "sequence_paused", "lead", leadId, { enrollment_id: enr.id, reason: d.reason, resume_on: d.resume_on ?? null });
    return { action: "pause", enrollment_id: enr.id, status: "paused", note: "The open step keeps its task, but it cannot be sent while the sequence is paused." };
  }
  if (enr.status !== "paused") throw new HttpError(409, `Only a paused sequence can be resumed (it is ${enr.status}).`);
  const settings = await seqSettings();
  const due = nextWorkday(todayYmd(), settings.weekends[(enr.market_group as MarketGroup) ?? "us"]).ymd;
  const step = await one("SELECT * FROM enrollment_steps WHERE enrollment_id=? AND status='planned' ORDER BY position LIMIT 1", [enr.id as number]);
  await run("UPDATE enrollments SET status='running', stop_reason=NULL, paused_until=NULL, updated_at=? WHERE id=?", [t, enr.id as number]);
  if (step && (step.due_on as string) < due) await moveStep(step, due, `Resumed by ${actor.name}`);
  await audit(actor, "sequence_resumed", "lead", leadId, { enrollment_id: enr.id, reason: d.reason, next_due_on: step ? (step.due_on as string) < due ? due : step.due_on : null });
  return { action: "resume", ...(await syncEnrollment(actor, leadId, enr.channel as string)) };
}
/** Moves an open step (and its task) to a later day, keeping the length of its window. */
async function moveStep(step: Row, dueOn: string, why: string) {
  const len = Math.max(0, diffDays((step.window_end_on as string) ?? (step.due_on as string), step.due_on as string));
  const end = addDays(dueOn, len), t = now();
  await run("UPDATE enrollment_steps SET due_on=?, window_end_on=?, note=?, updated_at=? WHERE id=?", [dueOn, end, why, t, step.id as number]);
  await run("UPDATE enrollments SET next_due_on=?, updated_at=? WHERE id=?", [dueOn, t, step.enrollment_id as number]);
  if (step.task_id && Number(step.task_id) > 0)
    await run("UPDATE tasks SET rescheduled_from=COALESCE(due_at,rescheduled_from), due_at=?, due_on=?, window_end_on=?, hold_reason=?, updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')", [endOfDay(dueOn), dueOn, end, why, t, step.task_id as number]);
  return { due_on: dueOn, window_end_on: end };
}
/** Out of office, or a first soft bounce: the open step waits. The total delay per lead is capped. */
export async function delayOpenStep(actor: Actor, leadId: number, untilOn: string, why: string, capDays: number) {
  const enr = await one("SELECT * FROM enrollments WHERE lead_id=? AND status='running' ORDER BY id LIMIT 1", [leadId]);
  if (!enr) return null;
  const step = await one("SELECT * FROM enrollment_steps WHERE enrollment_id=? AND status='planned' ORDER BY position LIMIT 1", [enr.id as number]);
  if (!step || (step.due_on as string) >= untilOn) return null;
  const left = capDays - Number(enr.delay_days);
  if (left <= 0) return { moved: false, note: `The step was already delayed ${enr.delay_days} days, the most allowed.` };
  const settings = await seqSettings();
  const add = Math.min(left, diffDays(untilOn, step.due_on as string));
  const due = nextWorkday(addDays(step.due_on as string, add), settings.weekends[(enr.market_group as MarketGroup) ?? "us"]).ymd;
  const moved = await moveStep(step, due, why);
  await run("UPDATE enrollments SET delay_days=delay_days+? WHERE id=?", [add, enr.id as number]);
  await audit(actor, "sequence_step_delayed", "lead", leadId, { enrollment_id: enr.id, step: step.step_code, ...moved, reason: why });
  return { moved: true, step: step.step_code, ...moved };
}

/* ---------- small task helpers used by the reply and bounce rules ---------- */
export async function systemTask(actor: Actor, lead: Row, o: { role: WorkRole; type: string; action: string; taskType?: string | null; instructions: string; dueAt?: string | null; dueOn?: string | null; who?: string | null }): Promise<number> {
  const open = await one("SELECT id FROM tasks WHERE lead_id=? AND action_type=? AND status NOT IN ('completed','cancelled') LIMIT 1", [lead.id as number, o.action]);
  if (open) return open.id as number;
  const roles = await roleUsers();
  const assignee = roles[o.role] ?? roles.chief ?? roles.owner ?? actor.id;
  const name = (await one("SELECT name FROM users WHERE id=?", [assignee]))?.name as string | undefined;
  const title = shortTitle(o.type, lead.company as string, o.who ?? name ?? null);
  const t = now();
  const dueAt = o.dueAt ?? (o.dueOn ? endOfDay(o.dueOn) : null);
  const r = await run("INSERT INTO tasks (lead_id,assignee_id,created_by,title,instructions,task_type,approval_from,due_at,due_on,is_demo,created_at,updated_at,action_type,auto_generated) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,1)",
    [lead.id as number, assignee, actor.id || assignee, title, o.instructions, o.taskType ?? null, dueAt, o.dueOn ?? null, lead.is_demo as number, t, t, o.action]);
  await run("INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", [lead.id as number, r.id, `Task created: ${title}`, o.instructions, actor.id || null, t, t, lead.is_demo as number]);
  await audit(actor, "sequence_task_created", "task", r.id, { lead_id: lead.id, action: o.action, assignee_id: assignee });
  return r.id;
}
/** `hours` working hours (09:00 to 17:00 on working days) after a moment, in the prospect's zone. */
export function addWorkingHours(iso: string, hours: number, group: MarketGroup, weekend: number[]): string {
  let t = new Date(iso).getTime(), left = hours * 60;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: MARKET_ZONE[group], hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (let guard = 0; guard < 500 && left > 0; guard++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const mins = Number(p.hour) * 60 + Number(p.minute);
    if (weekend.includes(dow(`${p.year}-${p.month}-${p.day}`)) || mins >= 17 * 60) { t += (24 * 60 - mins + 9 * 60) * 60000; continue; }
    if (mins < 9 * 60) { t += (9 * 60 - mins) * 60000; continue; }
    const use = Math.min(17 * 60 - mins, left);
    t += use * 60000; left -= use;
  }
  return new Date(t).toISOString();
}
export const emailDomain = (email: unknown) => { const m = /@([^@\s>]+)\s*>?\s*$/.exec(String(email ?? "").trim().toLowerCase()); return m ? m[1] : null; };
export const isFreeMail = (domain: string | null) => !domain || FREE_MAIL.includes(domain);

/* ---------- reads: one lead, and a page of leads ---------- */
export async function getLeadSequence(leadId: number) {
  const enrs = await all("SELECT e.*, s.name AS sequence, sd.email AS sender_email, sd.display_name AS sender_name FROM enrollments e JOIN sequences s ON s.id=e.sequence_id LEFT JOIN senders sd ON sd.id=e.sender_id WHERE e.lead_id=? ORDER BY e.id", [leadId]);
  const out = [];
  for (const e of enrs) {
    const [steps, def] = await Promise.all([
      all("SELECT st.*, t.status AS task_status, t.prep_status, t.title AS task_title FROM enrollment_steps st LEFT JOIN tasks t ON t.id=st.task_id WHERE st.enrollment_id=? ORDER BY st.position", [e.id as number]),
      all("SELECT position,step_code FROM sequence_steps WHERE sequence_id=? AND version=? AND active=1 ORDER BY position", [e.sequence_id as number, e.sequence_version as number]),
    ]);
    out.push({
      enrollment_id: e.id, channel: e.channel, sequence: { id: e.sequence_id, name: e.sequence, version: e.sequence_version }, status: e.status, stop_reason: e.stop_reason,
      sender: e.sender_id ? { id: e.sender_id, email: e.sender_email, display_name: e.sender_name } : null, thread_subject: e.thread_subject, experiment_labels: parseLabels(e.labels),
      steps_sent: e.steps_sent, step_total: def.length, next_due_on: e.next_due_on, rest_until: e.rest_until, paused_until: e.paused_until, first_sent_at: e.first_sent_at, last_sent_at: e.last_sent_at, backfilled: !!e.backfilled,
      steps: def.map((d) => {
        const s = steps.find((x) => x.position === d.position);
        return { position: d.position, step_code: d.step_code, label: STEP_LONG[d.step_code as string] ?? d.step_code, status: (s?.status as string) ?? "not_planned", due_on: s?.due_on ?? null, window_end_on: s?.window_end_on ?? null, late: !!s?.late,
          task_id: s?.task_id && Number(s.task_id) > 0 ? s.task_id : null, task_status: s?.task_status ?? null, prep_status: s?.prep_status ?? null, sent_at: s?.sent_at ?? null, message_version_id: s?.message_version_id ?? null, subject: s?.subject ?? null, note: s?.note ?? null };
      }),
    });
  }
  return out;
}
export const parseLabels = (v: unknown): string[] => { try { const x = v ? JSON.parse(String(v)) : []; return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

export type LeadSeq = { sequence_status: string | null; sequence_step: string | null; step_total: number | null; steps_sent: number; first_email_sent_at: string | null; last_email_sent_at: string | null; last_email_step: string | null; emails_sent_count: number; experiment_labels: string[]; rest_until: string | null; stop_reason: string | null; next_due_on: string | null; sender_id: number | null };
/** Sequence facts for a page of leads, in three queries. */
export async function leadSequenceInfo(leadIds: number[]): Promise<Map<number, LeadSeq>> {
  const out = new Map<number, LeadSeq>();
  if (!leadIds.length) return out;
  const marks = leadIds.map(() => "?").join(",");
  const [enrs, mails, totals] = await Promise.all([
    all(`SELECT * FROM enrollments WHERE lead_id IN (${marks}) ORDER BY (channel='email') DESC, id`, leadIds),
    all(`SELECT lead_id, COUNT(*) AS n, MIN(CASE WHEN occurred_precision<>'unknown' THEN occurred_at END) AS first_at, MAX(CASE WHEN occurred_precision<>'unknown' THEN occurred_at END) AS last_at
         FROM activities WHERE lead_id IN (${marks}) AND type='message' AND outcome='sent' AND COALESCE(channel,'email')='email' GROUP BY lead_id`, leadIds),
    all("SELECT sequence_id, version, COUNT(*) AS n FROM sequence_steps WHERE active=1 GROUP BY sequence_id, version"),
  ]);
  const total = new Map(totals.map((r) => [`${r.sequence_id}|${r.version}`, Number(r.n)]));
  const mail = new Map(mails.map((m) => [m.lead_id as number, m]));
  for (const id of leadIds) {
    const e = enrs.find((x) => x.lead_id === id) ?? null;
    const m = mail.get(id);
    const status = !e ? null : e.status === "stopped" ? (/bounce|opt/i.test(String(e.stop_reason ?? "")) ? "stopped_bounce" : /reply|interested|referral|not now/i.test(String(e.stop_reason ?? "")) ? "stopped_reply" : "stopped") : (e.status as string);
    out.set(id, {
      sequence_status: status, sequence_step: (e?.last_step_code as string) ?? null, step_total: e ? total.get(`${e.sequence_id}|${e.sequence_version}`) ?? null : null, steps_sent: e ? Number(e.steps_sent) : 0,
      first_email_sent_at: (m?.first_at as string) ?? null, last_email_sent_at: (m?.last_at as string) ?? null, last_email_step: e?.channel === "email" ? ((e.last_step_code as string) ?? null) : null,
      emails_sent_count: m ? Number(m.n) : 0, experiment_labels: parseLabels(e?.labels), rest_until: (e?.rest_until as string) ?? null, stop_reason: (e?.stop_reason as string) ?? null, next_due_on: (e?.next_due_on as string) ?? null, sender_id: (e?.sender_id as number) ?? null,
    });
  }
  return out;
}

/* ---------- backfill ---------- */
const backfillSchema = z.object({ campaign_id: z.coerce.number().int().nullable().optional(), dry_run: z.boolean().optional(), lead_ids: z.array(z.coerce.number().int()).max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
/**
 * Leads that were contacted before sequences existed. dry_run (the default) lists what would be planned and creates nothing.
 * dry_run:false enrolls them, at most `limit` leads per call (default 40); call again until remaining is 0.
 */
export async function backfill(actor: Actor, input: unknown) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or a Chief can run the backfill.");
  const d = parse(backfillSchema, input ?? {});
  const dry = d.dry_run !== false;
  const ctx = await loadCtx();
  const leads = await all(
    `SELECT l.* FROM leads l WHERE l.is_demo=0 AND l.historical_only=0
       AND EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent')
       AND NOT EXISTS (SELECT 1 FROM activities r WHERE r.lead_id=l.id AND r.type='reply')
       AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed'))
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')
       ${d.campaign_id ? "AND EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.campaign_id=? AND lc.status='active')" : ""}
     ORDER BY l.id`, d.campaign_id ? [d.campaign_id] : []);
  if (!leads.length) return { dry_run: dry, total: 0, summary: {}, items: [], remaining: 0 };
  const ids = leads.map((l) => l.id as number);
  const marks = ids.map(() => "?").join(",");
  const [sends, mems, enrs, bounced] = await Promise.all([
    all(SENDS_SQL(marks), ids),
    all(`SELECT lead_id,campaign_id FROM lead_campaigns WHERE status='active' AND lead_id IN (${marks}) ORDER BY id`, ids),
    all(`SELECT lead_id,channel FROM enrollments WHERE lead_id IN (${marks})`, ids),
    all(`SELECT lead_id FROM contacts WHERE lead_id IN (${marks}) GROUP BY lead_id HAVING SUM(CASE WHEN email_status='bounced' OR is_invalid=1 OR email IS NULL OR email='' THEN 0 ELSE 1 END)=0`, ids),
  ]);
  const noAddress = new Set(bounced.map((b) => b.lead_id as number));
  const today = todayYmd();
  const items: (LeadPlan & { state: string })[] = [];
  for (const l of leads) {
    const mine = sends.filter((s) => s.lead_id === l.id);
    for (const channel of [...new Set(mine.map((s) => s.channel as string))]) {
      if (enrs.some((e) => e.lead_id === l.id && e.channel === channel)) continue;
      if (channel === "email" && noAddress.has(l.id as number)) continue;
      const p = buildPlan(ctx, l, channel, mine, mems.filter((m) => m.lead_id === l.id).map((m) => m.campaign_id as number));
      if (!p) continue;
      items.push({ ...p, state: !p.next ? "finished" : p.next.late ? "late" : p.next.due_on < today ? "overdue" : p.next.due_on === today ? "due" : "upcoming" });
    }
  }
  const chosen = d.lead_ids ? items.filter((i) => d.lead_ids!.includes(i.lead_id)) : items;
  const count = (f: (i: (typeof items)[number]) => boolean) => chosen.filter(f).length;
  const summary = {
    leads: chosen.length, due_or_overdue: count((i) => ["due", "overdue", "late"].includes(i.state)), upcoming: count((i) => i.state === "upcoming"), sequence_finished_rest: count((i) => i.state === "finished"),
    late_items: count((i) => i.state === "late"), linkedin: count((i) => i.channel === "linkedin"), in_no_campaign: count((i) => i.no_campaign),
    by_step: Object.fromEntries([...new Set(chosen.filter((i) => i.next).map((i) => i.next!.code))].map((c) => [c, { due: count((i) => i.next?.code === c && ["due", "overdue"].includes(i.state)), late: count((i) => i.next?.code === c && i.state === "late"), upcoming: count((i) => i.next?.code === c && i.state === "upcoming") }])),
  };
  const rules = "Every overdue step gets a late follow-up on its original thread (label LATE, left out of experiment comparisons, no age cutoff). Nothing is sent and nothing is authorized: each task starts at draft_needed. Late items are spread by the daily late limit per sender. Leads in no campaign are included and flagged.";
  if (dry) return { dry_run: true, total: chosen.length, summary, rules, items: chosen, remaining: chosen.length };
  const batch = chosen.slice(0, d.limit ?? 40);
  const done: { lead_id: number; channel: string; status: string | null; task_id: number | null }[] = [];
  for (const it of batch) {
    const r = await syncEnrollment(actor, it.lead_id, it.channel, { ctx, backfill: true });
    done.push({ lead_id: it.lead_id, channel: it.channel, status: r.status, task_id: r.next_task_id });
  }
  await audit(actor, "sequence_backfill", "sequence", null, { committed: done.length, remaining: chosen.length - batch.length, campaign_id: d.campaign_id ?? null });
  return { dry_run: false, committed: done.length, remaining: chosen.length - batch.length, tasks_created: done.filter((x) => x.task_id).length, summary, rules, results: done, note: chosen.length > batch.length ? "Call again with the same body until remaining is 0." : "Backfill complete." };
}

/** A LinkedIn invitation was accepted: the lead enters the LinkedIn sequence and its first message is planned. */
export async function linkedinAccepted(actor: Actor, leadId: number, at: string) {
  const lead = await one("SELECT market,country FROM leads WHERE id=?", [leadId]);
  if (!lead) return null;
  const mem = await one("SELECT c.key,c.name FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.lead_id=? AND lc.status='active' ORDER BY lc.id DESC LIMIT 1", [leadId]);
  const on = todayYmd(MARKET_ZONE[marketOfCampaign(mem, lead)], new Date(at));
  try { return await syncEnrollment(actor, leadId, "linkedin", { acceptOn: on }); } catch (e) { console.error("linkedin sequence failed", e); return null; }
}
