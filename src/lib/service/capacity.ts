import { z } from "zod";
import { all, one, run, now, localMidnight, addDays, todayYmd, TZ } from "../db";
import { HttpError, type Actor } from "../auth";
import { audit, parse } from "./common";

/** Daily outreach capacity: a cap on messages sent per day (Asia/Hebron day), shared by all campaigns, with a campaign priority order. */
const CAP_KEY = "daily_send_cap";
const PRIO_KEY = "campaign_priority";
export const DEFAULT_DAILY_CAP = 10;

export async function capacitySettings() {
  const rows = await all("SELECT key,value FROM app_settings WHERE key IN (?,?)", [CAP_KEY, PRIO_KEY]);
  const c = rows.find((r) => r.key === CAP_KEY);
  const p = rows.find((r) => r.key === PRIO_KEY);
  let priority: number[] = [];
  try { priority = p?.value ? (JSON.parse(String(p.value)) as number[]) : []; } catch { priority = []; }
  return { daily_cap: c?.value != null && c.value !== "" ? Number(c.value) : DEFAULT_DAILY_CAP, priority };
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
  if (d.daily_cap !== undefined) await put(CAP_KEY, String(d.daily_cap));
  if (d.priority) await put(PRIO_KEY, JSON.stringify(d.priority));
  await audit(actor, "update_capacity", "setting", 0, { from: before, to: { daily_cap: d.daily_cap ?? before.daily_cap, priority: d.priority ?? before.priority } });
  return capacitySettings();
}

const dayRange = (ymd: string) => [localMidnight(ymd).toISOString(), localMidnight(addDays(ymd, 1)).toISOString()] as const;

/** Messages recorded as sent in the given day (exact-time sends only), in total and per campaign. */
export async function sentOn(ymd: string) {
  const [from, to] = dayRange(ymd);
  const rows = await all(
    `SELECT COALESCE(se.campaign_id, (SELECT lc.campaign_id FROM lead_campaigns lc WHERE lc.lead_id=a.lead_id AND lc.status='active' ORDER BY lc.id DESC LIMIT 1)) AS campaign_id, COUNT(*) AS n
     FROM activities a LEFT JOIN send_events se ON se.activity_id=a.id
     WHERE a.type='message' AND a.outcome='sent' AND a.is_demo=0 AND a.occurred_precision='time' AND a.occurred_at>=? AND a.occurred_at<? GROUP BY 1`, [from, to]);
  const per = new Map<number | null, number>();
  let total = 0;
  for (const r of rows) { per.set((r.campaign_id as number) ?? null, Number(r.n)); total += Number(r.n); }
  return { total, per };
}

export async function sentTodayTotal() {
  return (await sentOn(todayYmd())).total;
}

export async function capacityFor(date?: string) {
  const ymd = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayYmd();
  if (date && ymd !== date) throw new HttpError(400, "date: YYYY-MM-DD.");
  const [from, to] = dayRange(ymd);
  const set = await capacitySettings();
  const used = await sentOn(ymd);
  const reservedRows = await all(
    `SELECT mv.campaign_id, COUNT(DISTINCT t.id) AS n FROM tasks t
     JOIN message_versions mv ON mv.id=t.message_version_id
     JOIN send_authorizations a ON a.message_version_id=mv.id AND a.kind='send' AND a.status='active'
     WHERE t.status NOT IN ('completed','cancelled') AND t.is_demo=0 AND COALESCE(t.scheduled_at,t.due_at)>=? AND COALESCE(t.scheduled_at,t.due_at)<? GROUP BY mv.campaign_id`, [from, to]);
  const reserved = new Map<number, number>(reservedRows.map((r) => [r.campaign_id as number, Number(r.n)]));
  const camps = await all("SELECT id,name,status FROM campaigns WHERE status<>'closed' ORDER BY id");
  const rank = (id: number) => { const i = set.priority.indexOf(id); return i === -1 ? 1e6 + id : i; };
  camps.sort((a, b) => rank(a.id as number) - rank(b.id as number));
  const reservedTotal = [...reserved.values()].reduce((x, y) => x + y, 0);
  const unlimited = set.daily_cap === 0;
  let higherReserved = 0;
  const campaigns = camps.map((c) => {
    const id = c.id as number;
    const r = reserved.get(id) ?? 0;
    const out = {
      campaign_id: id, name: c.name, status: c.status,
      priority: set.priority.includes(id) ? set.priority.indexOf(id) + 1 : null,
      used: used.per.get(id) ?? 0, reserved: r,
      // what is left for this campaign once the sends done today and the reservations of higher-priority campaigns are taken out
      available_in_priority_order: unlimited ? null : Math.max(0, set.daily_cap - used.total - higherReserved),
    };
    higherReserved += r;
    return out;
  });
  return {
    date: ymd, timezone: TZ(), daily_cap: set.daily_cap, unlimited,
    used: used.total, reserved: reservedTotal,
    remaining: unlimited ? null : Math.max(0, set.daily_cap - used.total - reservedTotal),
    cap_reached: !unlimited && used.total >= set.daily_cap,
    used_unassigned: used.per.get(null) ?? 0,
    priority: set.priority, campaigns,
    rules: "used = messages recorded as sent that day (exact time, all campaigns). reserved = approved (Owner send authorization active) tasks scheduled that day that are not sent yet. remaining = cap - used - reserved. A send is blocked with daily_cap_reached once used reaches the cap.",
  };
}
