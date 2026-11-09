import { z } from "zod";
import { all, one, run, now, localMidnight, addDays, todayYmd, TZ } from "../db";
import { HttpError, type Actor } from "../auth";
import { audit, parse } from "./common";
import { loadSenders, capOn, statusOn, type Sender, type Step } from "./senders";

/** Daily outreach capacity, PER SENDER (Asia/Hebron day): each sender has its own cap or warm-up schedule; campaigns share a priority order used when reserving it. */
const CAP_KEY = "daily_send_cap"; // legacy shared cap; now the cap of the default sender (id 1)
const PRIO_KEY = "campaign_priority";
export const DEFAULT_DAILY_CAP = 10;

export async function capacitySettings() {
  const rows = await all("SELECT key,value FROM app_settings WHERE key IN (?,?)", [CAP_KEY, PRIO_KEY]);
  const c = rows.find((r) => r.key === CAP_KEY);
  const p = rows.find((r) => r.key === PRIO_KEY);
  let priority: number[] = [];
  try { priority = p?.value ? (JSON.parse(String(p.value)) as number[]) : []; } catch { priority = []; }
  void c;
  const s1 = await one("SELECT daily_cap FROM senders WHERE id=1");
  return { daily_cap: s1 ? (s1.daily_cap == null ? 0 : Number(s1.daily_cap)) : DEFAULT_DAILY_CAP, priority, note: "daily_cap here is the default sender's cap (0 = no cap). Each sender has its own cap/warm-up: see GET /senders." };
}

export async function setCapacitySettings(actor: Actor, input: unknown) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change the daily send cap.");
  const d = parse(z.object({ daily_cap: z.coerce.number().int().min(0).max(5000).optional(), priority: z.array(z.coerce.number().int()).max(100).optional() }), input);
  if (d.daily_cap === undefined && d.priority === undefined) throw new HttpError(400, "Send daily_cap (0 = no cap) and/or priority (campaign ids, highest first).");
  const before = await capacitySettings();
  if (d.priority) {
    if (new Set(d.priority).size !== d.priority.length) throw new HttpError(400, "priority: a campaign appears twice.");
    for (const id of d.priority) if (!(await one("SELECT id FROM campaigns WHERE id=?", [id]))) throw new HttpError(400, `priority: unknown campaign ${id}.`);
  }
  const put = (k: string, v: string) => run("INSERT INTO app_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [k, v, actor.id, now()]);
  if (d.daily_cap !== undefined) await run("UPDATE senders SET daily_cap=?, updated_at=? WHERE id=1", [d.daily_cap === 0 ? null : d.daily_cap, now()]);
  if (d.priority) await put(PRIO_KEY, JSON.stringify(d.priority));
  await audit(actor, "update_capacity", "setting", 0, { from: before, to: { daily_cap: d.daily_cap ?? before.daily_cap, priority: d.priority ?? before.priority } });
  return capacitySettings();
}

const dayRange = (ymd: string) => [localMidnight(ymd).toISOString(), localMidnight(addDays(ymd, 1)).toISOString()] as const;
const SENDER_SQL = "COALESCE(a.sender_id, se.sender_id, 1)";

/** Messages recorded as sent in the given day (exact-time sends only): total, per campaign, and per sender (each with its per-campaign split). */
export async function sentOn(ymd: string) {
  const [from, to] = dayRange(ymd);
  const rows = await all(
    `SELECT ${SENDER_SQL} AS sender_id, COALESCE(se.campaign_id, (SELECT lc.campaign_id FROM lead_campaigns lc WHERE lc.lead_id=a.lead_id AND lc.status='active' ORDER BY lc.id DESC LIMIT 1)) AS campaign_id, COUNT(*) AS n
     FROM activities a LEFT JOIN send_events se ON se.activity_id=a.id
     WHERE a.type='message' AND a.outcome='sent' AND a.is_demo=0 AND a.occurred_precision='time' AND a.occurred_at>=? AND a.occurred_at<? GROUP BY 1,2`, [from, to]);
  const per = new Map<number | null, number>();
  const bySender = new Map<number, { total: number; per: Map<number | null, number> }>();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n), c = (r.campaign_id as number) ?? null, sid = r.sender_id as number;
    per.set(c, (per.get(c) ?? 0) + n); total += n;
    const b = bySender.get(sid) ?? bySender.set(sid, { total: 0, per: new Map() }).get(sid)!;
    b.total += n; b.per.set(c, (b.per.get(c) ?? 0) + n);
  }
  return { total, per, bySender };
}

export async function sentTodayTotal() {
  return (await sentOn(todayYmd())).total;
}

export type SenderCap = {
  sender: Sender; steps: Step[]; cap: number | null; step_from: string | null; warmup: boolean; not_started: boolean;
  used: number; reserved: number; status: string; usedPer: Map<number | null, number>;
  campaigns: Map<number, { reserved: number; pushed: number }>; pushed: { task_id: number; message_version_id: number; lead_id: number; campaign_id: number; scheduled: string | null }[];
};

/**
 * Per-sender capacity for one day. Approved (Owner send authorization active) tasks scheduled that day (for today: also any overdue ones)
 * reserve a sender's remaining capacity in campaign-priority order; what does not fit is "pushed to the next day".
 */
export async function capacityData(ymd: string) {
  const [from, to] = dayRange(ymd);
  const today = todayYmd();
  const upper = to; // overdue tasks only count toward today
  const lower = ymd === today ? "0000-01-01T00:00:00.000Z" : from;
  const [{ senders, steps }, set, used, cand] = await Promise.all([
    loadSenders(), capacitySettings(), sentOn(ymd),
    all(
      `SELECT t.id AS task_id, mv.id AS message_version_id, mv.lead_id, mv.campaign_id, mv.sender_id, COALESCE(t.scheduled_at,t.due_at) AS scheduled
       FROM tasks t JOIN message_versions mv ON mv.id=t.message_version_id
       WHERE t.status NOT IN ('completed','cancelled') AND t.is_demo=0 AND COALESCE(t.scheduled_at,t.due_at)>=? AND COALESCE(t.scheduled_at,t.due_at)<?
         AND EXISTS (SELECT 1 FROM send_authorizations a WHERE a.message_version_id=mv.id AND a.kind='send' AND a.status='active')
       ORDER BY COALESCE(t.scheduled_at,t.due_at), t.id`, [lower, upper]),
  ]);
  const rank = (id: number) => { const i = set.priority.indexOf(id); return i === -1 ? 1e6 + id : i; };
  const out: SenderCap[] = senders.map((s) => {
    const st = steps.get(s.id) ?? [];
    const c = capOn(s, st, ymd);
    const u = used.bySender.get(s.id);
    const mine = cand.filter((r) => r.sender_id === s.id).sort((a, b) => rank(a.campaign_id as number) - rank(b.campaign_id as number));
    let room = c.cap === null ? Infinity : Math.max(0, c.cap - (u?.total ?? 0));
    const campaigns = new Map<number, { reserved: number; pushed: number }>();
    const pushed: SenderCap["pushed"] = [];
    let reserved = 0;
    for (const r of mine) {
      const k = campaigns.get(r.campaign_id as number) ?? campaigns.set(r.campaign_id as number, { reserved: 0, pushed: 0 }).get(r.campaign_id as number)!;
      if (room > 0) { room--; reserved++; k.reserved++; }
      else { k.pushed++; pushed.push({ task_id: r.task_id as number, message_version_id: r.message_version_id as number, lead_id: r.lead_id as number, campaign_id: r.campaign_id as number, scheduled: (r.scheduled as string) ?? null }); }
    }
    return { sender: s, steps: st, cap: c.cap, step_from: c.step_from, warmup: c.warmup, not_started: c.not_started, used: u?.total ?? 0, reserved, status: statusOn(s, st, ymd), usedPer: u?.per ?? new Map(), campaigns, pushed };
  });
  return { ymd, senders: out, used, set, rank };
}

export async function capacityFor(date?: string) {
  const ymd = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayYmd();
  if (date && ymd !== date) throw new HttpError(400, "date: YYYY-MM-DD.");
  const { senders, used, set, rank } = await capacityData(ymd);
  const camps = await all("SELECT id,name,status FROM campaigns WHERE status<>'closed' ORDER BY id");
  camps.sort((a, b) => rank(a.id as number) - rank(b.id as number));
  const sendersOut = senders.map((x) => {
    const unlimited = x.cap === null;
    const per = camps.map((c) => {
      const id = c.id as number;
      const allowed = x.sender.campaign_ids === null || x.sender.campaign_ids.includes(id);
      const k = x.campaigns.get(id);
      return { campaign_id: id, name: c.name, priority: set.priority.includes(id) ? set.priority.indexOf(id) + 1 : null, allowed, used: x.usedPer.get(id) ?? 0, reserved: k?.reserved ?? 0, pushed_to_next_day: k?.pushed ?? 0 };
    });
    return {
      sender_id: x.sender.id, email: x.sender.email, display_name: x.sender.display_name, status: x.status,
      daily_cap: x.cap, unlimited, warmup: x.warmup, warmup_not_started: x.not_started, warmup_step_from: x.step_from,
      used: x.used, reserved: x.reserved, remaining: unlimited ? null : Math.max(0, (x.cap as number) - x.used - x.reserved),
      cap_reached: !unlimited && x.used >= (x.cap as number),
      campaigns: per.filter((c) => c.allowed || c.used || c.reserved || c.pushed_to_next_day),
      pushed_to_next_day: x.pushed,
    };
  });
  const capped = sendersOut.filter((x) => !x.unlimited);
  const unlimited = sendersOut.some((x) => x.unlimited);
  const totalCap = unlimited ? null : capped.reduce((a, b) => a + (b.daily_cap as number), 0);
  const reservedTotal = sendersOut.reduce((a, b) => a + b.reserved, 0);
  // Per campaign across all senders.
  let higher = 0;
  const campaigns = camps.map((c) => {
    const id = c.id as number;
    const r = sendersOut.reduce((a, s) => a + (s.campaigns.find((x) => x.campaign_id === id)?.reserved ?? 0), 0);
    const pushed = sendersOut.reduce((a, s) => a + (s.campaigns.find((x) => x.campaign_id === id)?.pushed_to_next_day ?? 0), 0);
    const out = { campaign_id: id, name: c.name, status: c.status, priority: set.priority.includes(id) ? set.priority.indexOf(id) + 1 : null, used: used.per.get(id) ?? 0, reserved: r, pushed_to_next_day: pushed };
    higher += r;
    return out;
  });
  void higher;
  return {
    date: ymd, timezone: TZ(), senders: sendersOut, campaigns, priority: set.priority,
    pushed_to_next_day: sendersOut.flatMap((s) => s.pushed_to_next_day.map((p) => ({ ...p, sender_id: s.sender_id }))),
    // legacy totals (all senders together)
    daily_cap: totalCap, unlimited, used: used.total, reserved: reservedTotal,
    remaining: unlimited ? null : sendersOut.reduce((a, b) => a + (b.remaining ?? 0), 0),
    cap_reached: capped.length > 0 && !unlimited && capped.every((x) => x.used >= (x.daily_cap as number)),
    used_unassigned: used.per.get(null) ?? 0,
    rules: "Capacity is per sender (Asia/Hebron day). used = messages recorded as sent that day from that sender. reserved = approved (Owner send authorization active) tasks scheduled that day, taking the sender's remaining capacity in campaign-priority order (China, then US, then Gulf by default); tasks that do not fit are listed in pushed_to_next_day and are blocked with daily_cap_reached. remaining = cap - used - reserved. A sender with a warm-up schedule has cap 0 before its first step.",
  };
}
