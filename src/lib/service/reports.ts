import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, todayYmd, TZ, now, type Row } from "../db";
import { can, isManager, type Actor } from "./../auth";
import { leadScope } from "./leads";

/** Employees without team-report rights only ever see their own numbers. */
export function scopeEmployee(actor: Actor, requested?: number | null): number | undefined {
  if (can(actor, "reports.view") || isManager(actor)) return requested || undefined;
  return actor.id;
}

export type Metrics = {
  leads_added: number;
  first_emails: number;
  first_email_bounces: number;
  follow_ups: number;
  follow_up_bounces: number;
  replies: number;
  meetings: number;
  won: number;
  lost: number;
  completed: number;
};
const zero = (): Metrics => ({
  leads_added: 0, first_emails: 0, first_email_bounces: 0, follow_ups: 0, follow_up_bounces: 0,
  replies: 0, meetings: 0, won: 0, lost: 0, completed: 0,
});
export const rate = (num: number, den: number) => (den > 0 ? num / den : null);

type Raw = {
  acts: Row[]; leads: Row[]; tasks: Row[];
};

/** Open-ended range used by "since the beginning / all data". */
const ALL_FROM = "0000-01-01T00:00:00.000Z";
const ALL_TO = "9999-12-31T00:00:00.000Z";

/**
 * Everything below is computed from actually-logged rows only. Test rows are always excluded.
 * Each thing is counted on the date it HAPPENED, not the date it was entered into the CRM:
 *   leads -> lead_date (original date), sends/replies/stage changes -> occurred_at, bounces -> the bounce's own date.
 * Rows whose date is unknown are never placed in a period; they are only counted in the "all data" view.
 */
async function fetchRaw(fromISO: string, toISO: string, employee?: number, withUnknown = false): Promise<Raw> {
  const e = employee ? [employee] : [];
  const acts = await all(
    `SELECT a.type,a.message_kind,a.outcome,a.actor_id,a.occurred_at,sl.flag AS stage_flag, (a.occurred_precision='unknown') AS unk
     FROM activities a LEFT JOIN lists sl ON sl.kind='stage' AND sl.key=a.stage_to
     WHERE a.is_demo=0 AND a.type IN ('message','reply','status')
       AND ((a.occurred_precision<>'unknown' AND a.occurred_at>=? AND a.occurred_at<?)${withUnknown ? " OR a.occurred_precision='unknown'" : ""})
     ${employee ? "AND a.actor_id=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  // A bounce is attributed to the employee who sent the message, and dated when the bounce happened.
  const bounces = await all(
    `SELECT 'bounce' AS type,a.message_kind,a.outcome,p.actor_id AS actor_id,a.occurred_at,NULL AS stage_flag,(a.occurred_precision='unknown') AS unk
     FROM activities a JOIN activities p ON p.id=a.parent_id
     WHERE a.is_demo=0 AND a.type='outcome' AND a.outcome='bounced'
       AND ((a.occurred_precision<>'unknown' AND a.occurred_at>=? AND a.occurred_at<?)${withUnknown ? " OR a.occurred_precision='unknown'" : ""})
     ${employee ? "AND p.actor_id=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  const leads = await all(
    `SELECT created_by AS uid, lead_date AS at FROM leads
     WHERE is_demo=0 AND ((lead_date>=? AND lead_date<?)${withUnknown ? " OR lead_date IS NULL" : ""}) ${employee ? "AND created_by=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  const tasks = await all(
    `SELECT assignee_id AS uid, completed_at AS at FROM tasks WHERE is_demo=0 AND status='completed' AND completed_at>=? AND completed_at<? ${employee ? "AND assignee_id=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  return { acts: [...acts, ...bounces], leads, tasks };
}

/** mode: "dated" = only rows dated inside the range; "all" = those plus unknown-date rows; "unknown" = only unknown-date rows. */
type Mode = "dated" | "all" | "unknown";
function aggregate(raw: Raw, fromISO: string, toISO: string, uid?: number, mode: Mode = "dated"): Metrics {
  const m = zero();
  const take = (unk: boolean, t: string | null) =>
    unk || t == null ? mode !== "dated" : mode !== "unknown" && t >= fromISO && t < toISO;
  for (const a of raw.acts) {
    if (uid && a.actor_id !== uid) continue;
    if (!take(!!Number(a.unk), a.occurred_at)) continue;
    if (a.type === "message" && a.outcome === "sent") {
      if (a.message_kind === "first_email") m.first_emails++;
      else if (a.message_kind === "follow_up") m.follow_ups++;
    } else if (a.type === "bounce") {
      if (a.message_kind === "first_email") m.first_email_bounces++;
      else if (a.message_kind === "follow_up") m.follow_up_bounces++;
    } else if (a.type === "reply") m.replies++;
    else if (a.type === "status") {
      if (a.stage_flag === "meeting") m.meetings++;
      else if (a.stage_flag === "won") m.won++;
      else if (a.stage_flag === "lost") m.lost++;
    }
  }
  for (const l of raw.leads) if ((!uid || l.uid === uid) && take(l.at == null, l.at)) m.leads_added++;
  if (mode !== "unknown") for (const t of raw.tasks) if (inRange(t.at, fromISO, toISO) && (!uid || t.uid === uid)) m.completed++;
  return m;
}
const inRange = (t: string, f: string, to: string) => t >= f && t < to;

/** How many records have no known date (so they cannot sit in any period). */
export async function unknownDateCounts(employee?: number) {
  const l = await one(`SELECT COUNT(*) AS n FROM leads WHERE is_demo=0 AND lead_date IS NULL${employee ? " AND created_by=?" : ""}`, employee ? [employee] : []);
  const a = await one(
    `SELECT COUNT(*) AS n FROM activities a WHERE a.is_demo=0 AND a.occurred_precision='unknown' AND a.type IN ('message','reply','outcome','status')${employee ? " AND a.actor_id=?" : ""}`,
    employee ? [employee] : [],
  );
  return { leads: Number(l!.n), activities: Number(a!.n) };
}

/* ---------- period helpers ---------- */
export type Granularity = "day" | "week" | "month";

function bucketStart(ymd: string, g: Granularity): string {
  if (g === "day") return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  if (g === "month") return `${y}-${String(m).padStart(2, "0")}-01`;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -((dow + 6) % 7));
}
function nextStart(ymd: string, g: Granularity): string {
  if (g === "day") return addDays(ymd, 1);
  if (g === "week") return addDays(ymd, 7);
  const [y, m] = ymd.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
function prevStart(ymd: string, g: Granularity): string {
  if (g === "day") return addDays(ymd, -1);
  if (g === "week") return addDays(ymd, -7);
  const [y, m] = ymd.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}
export function periodLabel(startYmd: string, g: Granularity): string {
  const [y, m, d] = startYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(dt);
  if (g === "month") return f({ month: "short", year: "numeric" });
  if (g === "week") return `Week of ${f({ day: "numeric", month: "short" })}`;
  return f({ weekday: "short", day: "numeric", month: "short" });
}

const isYmd = (v?: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A custom "from → to" period or "since the beginning": totals plus a breakdown (days/weeks/months by length). */
async function getRangeReport(actor: Actor, opts: { all?: boolean; from?: string; to?: string; employee?: number | null }) {
  const employee = scopeEmployee(actor, opts.employee);
  const all_ = !!opts.all;
  const today = todayYmd();
  let from: string, to: string;
  if (all_) {
    // Earliest dated record, to size the breakdown.
    const e = employee ? [employee] : [];
    const row = await one(
      `SELECT MIN(d) AS d FROM (
         SELECT MIN(lead_date) AS d FROM leads WHERE is_demo=0 AND lead_date IS NOT NULL${employee ? " AND created_by=?" : ""}
         UNION ALL SELECT MIN(occurred_at) FROM activities WHERE is_demo=0 AND occurred_precision<>'unknown'${employee ? " AND actor_id=?" : ""}
         UNION ALL SELECT MIN(completed_at) FROM tasks WHERE is_demo=0 AND status='completed'${employee ? " AND assignee_id=?" : ""})`,
      [...e, ...e, ...e],
    );
    from = row?.d ? todayYmd(undefined, new Date(row.d as string)) : today;
    to = today;
  } else {
    from = isYmd(opts.from) ? opts.from : today;
    to = isYmd(opts.to) && opts.to >= from ? opts.to : from;
  }
  const fromISO = all_ ? ALL_FROM : localMidnight(from).toISOString();
  const toISO = all_ ? ALL_TO : localMidnight(addDays(to, 1)).toISOString();
  const raw = await fetchRaw(fromISO, toISO, employee, all_);

  const days = Math.round((localMidnight(to).getTime() - localMidnight(from).getTime()) / 86400000) + 1;
  const g: Granularity = days <= 31 ? "day" : days <= 200 ? "week" : "month";
  const starts: string[] = [];
  for (let s = bucketStart(from, g); s <= to && starts.length < 120; s = nextStart(s, g)) starts.push(s);
  const buckets = starts.map((s) => {
    const f = localMidnight(s < from ? from : s).toISOString();
    const t = localMidnight(nextStart(s, g) > addDays(to, 1) ? addDays(to, 1) : nextStart(s, g)).toISOString();
    return { start: s, label: periodLabel(s, g), from: f, to: t, m: aggregate(raw, f, t) };
  });
  const totals = aggregate(raw, fromISO, toISO, undefined, all_ ? "all" : "dated");
  const unknown = all_ ? aggregate(raw, fromISO, toISO, undefined, "unknown") : null;
  const users = await all(`SELECT id,name,role,active FROM users WHERE ${employee ? "id=?" : "1=1"} ORDER BY active DESC, name`, employee ? [employee] : []);
  const overdue = await overdueByEmployee();
  const byEmployee = users
    .map((u) => ({ user: u, m: aggregate(raw, fromISO, toISO, u.id, all_ ? "all" : "dated"), overdue: overdue.get(u.id) ?? 0 }))
    .filter((r) => r.user.active || Object.values(r.m).some(Boolean) || r.overdue);
  const totalOverdue = employee ? overdue.get(employee) ?? 0 : [...overdue.values()].reduce((a, b) => a + b, 0);
  return {
    mode: (all_ ? "all" : "range") as "all" | "range", from, to, breakdown: g, tz: TZ(), employee: employee ?? null,
    buckets, totals, unknown, byEmployee, totalOverdue, unknownCounts: await unknownDateCounts(employee),
  };
}
export { getRangeReport };

export async function getReport(actor: Actor, opts: { granularity: Granularity; at?: string; employee?: number | null }) {
  const g = opts.granularity;
  const employee = scopeEmployee(actor, opts.employee);
  const count = g === "day" ? 14 : 12;
  const at = opts.at && /^\d{4}-\d{2}-\d{2}$/.test(opts.at) ? opts.at : todayYmd();
  const starts: string[] = [bucketStart(at, g)];
  while (starts.length < count) starts.unshift(prevStart(starts[0], g));
  const endYmd = nextStart(starts[starts.length - 1], g);
  const fromISO = localMidnight(starts[0]).toISOString();
  const toISO = localMidnight(endYmd).toISOString();
  const raw = await fetchRaw(fromISO, toISO, employee);

  const buckets = starts.map((s) => {
    const f = localMidnight(s).toISOString();
    const t = localMidnight(nextStart(s, g)).toISOString();
    return { start: s, label: periodLabel(s, g), from: f, to: t, m: aggregate(raw, f, t) };
  });
  const cur = buckets[buckets.length - 1];

  const users = await all(`SELECT id,name,role,active FROM users WHERE ${employee ? "id=?" : "1=1"} ORDER BY active DESC, name`, employee ? [employee] : []);
  const overdue = await overdueByEmployee();
  const byEmployee = users
    .map((u) => ({ user: u, m: aggregate(raw, cur.from, cur.to, u.id), overdue: overdue.get(u.id) ?? 0 }))
    .filter((r) => r.user.active || Object.values(r.m).some(Boolean) || r.overdue);
  const totals = cur.m;
  const totalOverdue = employee ? overdue.get(employee) ?? 0 : [...overdue.values()].reduce((a, b) => a + b, 0);
  return {
    granularity: g, at, tz: TZ(), employee: employee ?? null, buckets, current: cur,
    prevStart: prevStart(starts[0], g), nextStart: endYmd, byEmployee, totals, totalOverdue, unknownCounts: await unknownDateCounts(employee),
  };
}

async function overdueByEmployee(): Promise<Map<number, number>> {
  const rows = await all(
    `SELECT assignee_id AS uid, COUNT(*) AS n FROM tasks
     WHERE is_demo=0 AND due_at < ? AND status IN ('todo','in_progress','changes_requested','approved') GROUP BY assignee_id`,
    [now()],
  );
  return new Map(rows.map((r) => [r.uid as number, Number(r.n)]));
}

/* ---------- dashboard ---------- */
export async function getDashboard(actor: Actor, opts: { from?: string; to?: string; employee?: number | null; all?: boolean }) {
  const employee = scopeEmployee(actor, opts.employee);
  const today = todayYmd();
  const allTime = !!opts.all;
  const from = isYmd(opts.from) ? opts.from : today;
  const to = isYmd(opts.to) && opts.to >= from ? opts.to : from;
  const fromISO = allTime ? ALL_FROM : localMidnight(from).toISOString();
  const toISO = allTime ? ALL_TO : localMidnight(addDays(to, 1)).toISOString();

  const raw = await fetchRaw(fromISO, toISO, employee, allTime);
  const m = aggregate(raw, fromISO, toISO, undefined, allTime ? "all" : "dated");
  // Period views never include unknown-date activity (it would otherwise look like "today").
  const known = allTime ? "" : " AND a.occurred_precision<>'unknown'";

  const ea = employee ? " AND a.actor_id=?" : "";
  const ea1: InValue[] = employee ? [employee] : [];
  const counts = await all(
    `SELECT a.type, COUNT(*) AS n FROM activities a WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<? AND a.type IN ('research','draft','note','status')${known}${ea} GROUP BY a.type`,
    [fromISO, toISO, ...ea1],
  );
  const c: Record<string, number> = Object.fromEntries(counts.map((r) => [r.type, Number(r.n)]));

  const replies = await all(
    `SELECT a.id,a.lead_id,a.occurred_at,a.title,a.body,l.company,u.name AS actor_name
     FROM activities a JOIN leads l ON l.id=a.lead_id JOIN users u ON u.id=a.actor_id
     WHERE a.is_demo=0 AND a.type='reply' AND a.occurred_at>=? AND a.occurred_at<?${known}${ea} ORDER BY a.occurred_at DESC LIMIT 8`,
    [fromISO, toISO, ...ea1],
  );

  const sc = leadScope(actor);
  const stageRows = await all(
    `SELECT s.key,s.label,s.flag,s.active,
       (SELECT COUNT(*) FROM leads l WHERE l.stage=s.key AND l.is_demo=0 AND ${sc.sql}${employee ? " AND l.owner_id=?" : ""}) AS n
     FROM lists s WHERE s.kind='stage' ORDER BY s.position,s.id`,
    [...sc.args, ...(employee ? [employee] : [])],
  );
  const byStage = stageRows.filter((r) => r.active || Number(r.n) > 0).map((r) => ({ key: r.key, label: r.label, flag: r.flag, n: Number(r.n) }));

  const overdueArgs: InValue[] = [now(), ...(employee ? [employee] : [])];
  const overdueTasks = await all(
    `SELECT t.id,t.title,t.due_at,t.status,t.lead_id,l.company,u.name AS assignee_name FROM tasks t
     JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id
     WHERE t.is_demo=0 AND t.due_at < ? AND t.status IN ('todo','in_progress','changes_requested','approved')${employee ? " AND t.assignee_id=?" : ""}
     ORDER BY t.due_at ASC LIMIT 10`,
    overdueArgs,
  );
  const overdueCount = Number(
    (await one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at < ? AND t.status IN ('todo','in_progress','changes_requested','approved')${employee ? " AND t.assignee_id=?" : ""}`, overdueArgs))!.n,
  );

  const pend = await all(
    `SELECT a.requires, COUNT(*) AS n FROM approvals a WHERE a.is_demo=0 AND a.status='pending'${employee ? " AND a.submitted_by=?" : ""} GROUP BY a.requires`,
    employee ? [employee] : [],
  );
  const pending = { chief: 0, wisam: 0 };
  for (const p of pend) pending[p.requires as "chief" | "wisam"] = Number(p.n);
  const pendingList = await all(
    `SELECT a.id,a.title,a.requires,a.created_at,l.company,u.name AS submitted_by_name FROM approvals a
     JOIN users u ON u.id=a.submitted_by LEFT JOIN leads l ON l.id=a.lead_id
     WHERE a.is_demo=0 AND a.status='pending'${employee ? " AND a.submitted_by=?" : ""} ORDER BY a.created_at ASC LIMIT 8`,
    employee ? [employee] : [],
  );

  const feed = await all(
    `SELECT a.id,a.lead_id,a.type,a.message_kind,a.outcome,a.title,a.occurred_at,a.stage_to,l.company,u.name AS actor_name
     FROM activities a JOIN leads l ON l.id=a.lead_id JOIN users u ON u.id=a.actor_id
     WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<?${known}${ea} ORDER BY a.occurred_at DESC LIMIT 12`,
    [fromISO, toISO, ...ea1],
  );

  return {
    from, to, today, all: allTime, unknownCounts: await unknownDateCounts(employee), employee: employee ?? null, m, counts: c, replies, byStage, overdueTasks, overdueCount,
    pending, pendingList, feed,
    firstBounceRate: rate(m.first_email_bounces, m.first_emails),
    followBounceRate: rate(m.follow_up_bounces, m.follow_ups),
  };
}
