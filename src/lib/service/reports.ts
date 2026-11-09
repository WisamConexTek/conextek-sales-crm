import type { InValue } from "@libsql/client";
import { HttpError } from "../auth";
import { all, one, localMidnight, addDays, todayYmd, TZ, now, type Row } from "../db";
import { can, isManager, type Actor } from "./../auth";
import { leadScope } from "./leads";

/** Employees without team-report rights only ever see their own numbers. */
export function scopeEmployee(actor: Actor, requested?: number | null): number | undefined {
  if (can(actor, "reports.view") || isManager(actor)) return requested === 0 ? 0 : requested || undefined;
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
  /** Messages SENT in the period that have a bounce (any date) — the send-date cohort view of bounces. */
  first_email_cohort_bounces: number;
  follow_up_cohort_bounces: number;
  /** Distinct leads with at least one reply in the period (replies counts every inbound reply). */
  reply_leads: number;
};
const zero = (): Metrics => ({
  leads_added: 0, first_emails: 0, first_email_bounces: 0, follow_ups: 0, follow_up_bounces: 0,
  replies: 0, meetings: 0, won: 0, lost: 0, completed: 0,
  first_email_cohort_bounces: 0, follow_up_cohort_bounces: 0, reply_leads: 0,
});
/** SQL filter for an employee column. 0 = unknown original employee (NULL). */
const ef = (col: string, e?: number) => (e === undefined ? "" : e === 0 ? ` AND ${col} IS NULL` : ` AND ${col}=?`);
const ea_ = (e?: number): number[] => (e ? [e] : []);
export const UNKNOWN_EMPLOYEE = "Unknown original employee";
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
async function fetchRaw(fromISO: string, toISO: string, employee?: number, withUnknown = false, sender?: number): Promise<Raw> {
  const e = ea_(employee);
  const sA = sender !== undefined ? [sender] : [];
  const pActs = all(
    `SELECT a.type,a.message_kind,a.outcome,a.actor_id,a.lead_id,a.occurred_at,sl.flag AS stage_flag, (a.occurred_precision='unknown') AS unk, CASE WHEN a.type='status' THEN NULL ELSE COALESCE(a.sender_id,pp.sender_id,1) END AS sender_id,
            EXISTS(SELECT 1 FROM activities b WHERE b.parent_id=a.id AND b.outcome='bounced') AS has_bounce
     FROM activities a LEFT JOIN lists sl ON sl.kind='stage' AND sl.key=a.stage_to LEFT JOIN activities pp ON pp.id=a.parent_id
     WHERE a.is_demo=0 AND a.type IN ('message','reply','status')${sender !== undefined ? " AND a.type<>'status' AND COALESCE(a.sender_id,pp.sender_id,1)=?" : ""}
       AND ((a.occurred_precision<>'unknown' AND a.occurred_at>=? AND a.occurred_at<?)${withUnknown ? " OR a.occurred_precision='unknown'" : ""})
     ${ef("a.actor_id", employee)}`,
    [...sA, fromISO, toISO, ...e],
  );
  // A bounce is attributed to the employee who sent the message, and dated when the bounce happened.
  const pBounces = all(
    `SELECT 'bounce' AS type,a.message_kind,a.outcome,p.actor_id AS actor_id,a.lead_id,a.occurred_at,NULL AS stage_flag,(a.occurred_precision='unknown') AS unk, COALESCE(a.sender_id,p.sender_id,1) AS sender_id, 0 AS has_bounce
     FROM activities a JOIN activities p ON p.id=a.parent_id
     WHERE a.is_demo=0 AND a.type='outcome' AND a.outcome='bounced'${sender !== undefined ? " AND COALESCE(a.sender_id,p.sender_id,1)=?" : ""}
       AND ((a.occurred_precision<>'unknown' AND a.occurred_at>=? AND a.occurred_at<?)${withUnknown ? " OR a.occurred_precision='unknown'" : ""})
     ${ef("p.actor_id", employee)}`,
    [...sA, fromISO, toISO, ...e],
  );
  const pLeads = all(
    `SELECT created_by AS uid, lead_date AS at FROM leads
     WHERE is_demo=0 AND historical_only=0${sender !== undefined ? " AND 0" : ""} AND ((lead_date>=? AND lead_date<?)${withUnknown ? " OR lead_date IS NULL" : ""}) ${ef("created_by", employee)}`,
    [fromISO, toISO, ...e],
  );
  const pTasks = all(
    `SELECT assignee_id AS uid, completed_at AS at FROM tasks WHERE is_demo=0${sender !== undefined ? " AND 0" : ""} AND status='completed' AND completed_at>=? AND completed_at<? ${ef("assignee_id", employee)}`,
    [fromISO, toISO, ...e],
  );
  const [acts, bounces, leads, tasks] = await Promise.all([pActs, pBounces, pLeads, pTasks]);
  return { acts: [...acts, ...bounces], leads, tasks };
}

/** mode: "dated" = only rows dated inside the range; "all" = those plus unknown-date rows; "unknown" = only unknown-date rows. */
type Mode = "dated" | "all" | "unknown";
function aggregate(raw: Raw, fromISO: string, toISO: string, uid?: number, mode: Mode = "dated", sid?: number): Metrics {
  const m = zero();
  const replyLeads = new Set<number>();
  const take = (unk: boolean, t: string | null) =>
    unk || t == null ? mode !== "dated" : mode !== "unknown" && t >= fromISO && t < toISO;
  for (const a of raw.acts) {
    if (uid !== undefined && (a.actor_id ?? 0) !== uid) continue;
    if (sid !== undefined && a.sender_id !== sid) continue;
    if (!take(!!Number(a.unk), a.occurred_at)) continue;
    if (a.type === "message" && a.outcome === "sent") {
      if (a.message_kind === "first_email") (m.first_emails++, (m.first_email_cohort_bounces += Number(a.has_bounce) ? 1 : 0));
      else if (a.message_kind === "follow_up") (m.follow_ups++, (m.follow_up_cohort_bounces += Number(a.has_bounce) ? 1 : 0));
    } else if (a.type === "bounce") {
      if (a.message_kind === "first_email") m.first_email_bounces++;
      else if (a.message_kind === "follow_up") m.follow_up_bounces++;
    } else if (a.type === "reply") (m.replies++, replyLeads.add(a.lead_id));
    else if (a.type === "status") {
      if (a.stage_flag === "meeting") m.meetings++;
      else if (a.stage_flag === "won") m.won++;
      else if (a.stage_flag === "lost") m.lost++;
    }
  }
  m.reply_leads = replyLeads.size;
  if (sid === undefined) for (const l of raw.leads) if ((uid === undefined || (l.uid ?? 0) === uid) && take(l.at == null, l.at)) m.leads_added++;
  if (sid === undefined && mode !== "unknown") for (const t of raw.tasks) if (inRange(t.at, fromISO, toISO) && (uid === undefined || t.uid === uid)) m.completed++;
  return m;
}
const inRange = (t: string, f: string, to: string) => t >= f && t < to;

/** How many records have no known date (so they cannot sit in any period). */
export async function unknownDateCounts(employee?: number) {
  const [l, a] = await Promise.all([one(`SELECT COUNT(*) AS n FROM leads WHERE is_demo=0 AND historical_only=0 AND lead_date IS NULL${ef("created_by", employee)}`, ea_(employee)), one(
    `SELECT COUNT(*) AS n FROM activities a WHERE a.is_demo=0 AND a.occurred_precision='unknown' AND a.type IN ('message','reply','outcome','status')${ef("a.actor_id", employee)}`,
    ea_(employee),
  )]);
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

/** The same message numbers split by sending mailbox (a sender filter narrows the list to that mailbox). */
async function splitBySender(raw: Raw, fromISO: string, toISO: string, mode: Mode, only?: number) {
  const senders = await all("SELECT id,email,display_name FROM senders ORDER BY id");
  return senders.filter((s) => only === undefined || s.id === only).map((s) => ({ sender_id: s.id as number, email: s.email as string, name: s.display_name as string, m: aggregate(raw, fromISO, toISO, undefined, mode, s.id as number) }));
}
/** A custom "from → to" period or "since the beginning": totals plus a breakdown (days/weeks/months by length). */
async function getRangeReport(actor: Actor, opts: { all?: boolean; from?: string; to?: string; employee?: number | null; sender?: number | null }) {
  const sender = opts.sender ? opts.sender : undefined;
  const employee = scopeEmployee(actor, opts.employee);
  const all_ = !!opts.all;
  const today = todayYmd();
  let from: string, to: string;
  if (all_) {
    // Earliest dated record, to size the breakdown.
    const e = ea_(employee);
    const row = await one(
      `SELECT MIN(d) AS d FROM (
         SELECT MIN(lead_date) AS d FROM leads WHERE is_demo=0 AND historical_only=0 AND lead_date IS NOT NULL${ef("created_by", employee)}
         UNION ALL SELECT MIN(occurred_at) FROM activities WHERE is_demo=0 AND occurred_precision<>'unknown'${ef("actor_id", employee)}
         UNION ALL SELECT MIN(completed_at) FROM tasks WHERE is_demo=0 AND status='completed'${ef("assignee_id", employee)})`,
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
  const raw = await fetchRaw(fromISO, toISO, employee, all_, sender);

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
  const users = employee === 0 ? [] : await all(`SELECT id,name,role,active FROM users WHERE ${employee ? "id=?" : "1=1"} ORDER BY active DESC, name`, ea_(employee));
  const overdue = await overdueByEmployee();
  const byEmployee = users
    .map((u) => ({ user: u, m: aggregate(raw, fromISO, toISO, u.id, all_ ? "all" : "dated"), overdue: overdue.get(u.id) ?? 0 }))
    .filter((r) => r.user.active || Object.values(r.m).some(Boolean) || r.overdue);
  // Records whose original employee is unknown are in the totals but credited to nobody.
  if (employee === undefined || employee === 0) {
    const um = aggregate(raw, fromISO, toISO, 0, all_ ? "all" : "dated");
    if (Object.values(um).some(Boolean)) byEmployee.push({ user: { id: 0, name: UNKNOWN_EMPLOYEE, role: "unknown", active: 1 }, m: um, overdue: 0 });
  }
  const totalOverdue = employee === 0 ? 0 : employee ? overdue.get(employee) ?? 0 : [...overdue.values()].reduce((a, b) => a + b, 0);
  const bySender = await splitBySender(raw, fromISO, toISO, all_ ? "all" : "dated", sender);
  return {
    bySender, sender: sender ?? null,
    mode: (all_ ? "all" : "range") as "all" | "range", from, to, breakdown: g, tz: TZ(), employee: employee ?? null,
    buckets, totals, unknown, byEmployee, totalOverdue, unknownCounts: await unknownDateCounts(employee),
  };
}
export { getRangeReport };

export async function getReport(actor: Actor, opts: { granularity: Granularity; at?: string; employee?: number | null; sender?: number | null }) {
  const sender = opts.sender ? opts.sender : undefined;
  const g = opts.granularity;
  const employee = scopeEmployee(actor, opts.employee);
  const count = g === "day" ? 14 : 12;
  const at = opts.at && /^\d{4}-\d{2}-\d{2}$/.test(opts.at) ? opts.at : todayYmd();
  const starts: string[] = [bucketStart(at, g)];
  while (starts.length < count) starts.unshift(prevStart(starts[0], g));
  const endYmd = nextStart(starts[starts.length - 1], g);
  const fromISO = localMidnight(starts[0]).toISOString();
  const toISO = localMidnight(endYmd).toISOString();
  const raw = await fetchRaw(fromISO, toISO, employee, false, sender);

  const buckets = starts.map((s) => {
    const f = localMidnight(s).toISOString();
    const t = localMidnight(nextStart(s, g)).toISOString();
    return { start: s, label: periodLabel(s, g), from: f, to: t, m: aggregate(raw, f, t) };
  });
  const cur = buckets[buckets.length - 1];

  const users = employee === 0 ? [] : await all(`SELECT id,name,role,active FROM users WHERE ${employee ? "id=?" : "1=1"} ORDER BY active DESC, name`, ea_(employee));
  const overdue = await overdueByEmployee();
  const byEmployee = users
    .map((u) => ({ user: u, m: aggregate(raw, cur.from, cur.to, u.id), overdue: overdue.get(u.id) ?? 0 }))
    .filter((r) => r.user.active || Object.values(r.m).some(Boolean) || r.overdue);
  if (employee === undefined || employee === 0) {
    const um = aggregate(raw, cur.from, cur.to, 0);
    if (Object.values(um).some(Boolean)) byEmployee.push({ user: { id: 0, name: UNKNOWN_EMPLOYEE, role: "unknown", active: 1 }, m: um, overdue: 0 });
  }
  const totals = cur.m;
  const totalOverdue = employee === 0 ? 0 : employee ? overdue.get(employee) ?? 0 : [...overdue.values()].reduce((a, b) => a + b, 0);
  const bySender = await splitBySender(raw, cur.from, cur.to, "dated", sender);
  return {
    bySender, sender: sender ?? null,
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
  const employee = scopeEmployee(actor, opts.employee) || undefined; // unknown-employee filter exists only in /reports
  const today = todayYmd();
  const allTime = !!opts.all;
  const from = isYmd(opts.from) ? opts.from : today;
  const to = isYmd(opts.to) && opts.to >= from ? opts.to : from;
  const fromISO = allTime ? ALL_FROM : localMidnight(from).toISOString();
  const toISO = allTime ? ALL_TO : localMidnight(addDays(to, 1)).toISOString();

  // Period views never include unknown-date activity (it would otherwise look like "today").
  const known = allTime ? "" : " AND a.occurred_precision<>'unknown'";

  const ea = employee ? " AND a.actor_id=?" : "";
  const ea1: InValue[] = employee ? [employee] : [];
  const sc = leadScope(actor);
  const overdueArgs: InValue[] = [now(), ...(employee ? [employee] : [])];
  const [counts, replies, stageRows, overdueTasks, pend, pendingList, feed, overdueRow, raw, unknownCounts] = await Promise.all([
    all(
    `SELECT a.type, COUNT(*) AS n FROM activities a WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<? AND a.type IN ('research','draft','note','status')${known}${ea} GROUP BY a.type`,
    [fromISO, toISO, ...ea1],
  ),
    all(
    `SELECT a.id,a.lead_id,a.occurred_at,a.title,a.body,l.company,COALESCE(u.name,'Unknown original employee') AS actor_name
     FROM activities a JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.is_demo=0 AND a.type='reply' AND a.occurred_at>=? AND a.occurred_at<?${known}${ea} ORDER BY a.occurred_at DESC LIMIT 8`,
    [fromISO, toISO, ...ea1],
  ),
    all(
    `SELECT s.key,s.label,s.flag,s.active,
       (SELECT COUNT(*) FROM leads l WHERE l.stage=s.key AND l.is_demo=0 AND l.historical_only=0 AND ${sc.sql}${employee ? " AND l.owner_id=?" : ""}) AS n
     FROM lists s WHERE s.kind='stage' ORDER BY s.position,s.id`,
    [...sc.args, ...(employee ? [employee] : [])],
  ),
    all(
    `SELECT t.id,t.title,t.due_at,t.status,t.lead_id,t.task_type,l.company,u.name AS assignee_name FROM tasks t
     JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id
     WHERE t.is_demo=0 AND t.due_at < ? AND t.status IN ('todo','in_progress','changes_requested','approved')${employee ? " AND t.assignee_id=?" : ""}
     ORDER BY t.due_at ASC LIMIT 8`,
    overdueArgs,
  ),
    all(
    `SELECT a.requires, COUNT(*) AS n FROM approvals a WHERE a.is_demo=0 AND a.status='pending'${employee ? " AND a.submitted_by=?" : ""} GROUP BY a.requires`,
    employee ? [employee] : [],
  ),
    all(
    `SELECT a.id,a.title,a.kind,a.lead_id,a.requires,a.created_at,l.company,u.name AS submitted_by_name FROM approvals a
     JOIN users u ON u.id=a.submitted_by LEFT JOIN leads l ON l.id=a.lead_id
     WHERE a.is_demo=0 AND a.status='pending'${employee ? " AND a.submitted_by=?" : ""} ORDER BY a.created_at ASC LIMIT 8`,
    employee ? [employee] : [],
  ),
    all(
    `SELECT a.id,a.lead_id,a.type,a.message_kind,a.outcome,a.title,a.occurred_at,a.stage_to,l.company,COALESCE(u.name,'Unknown original employee') AS actor_name
     FROM activities a JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<?${known}${ea} ORDER BY a.occurred_at DESC LIMIT 12`,
    [fromISO, toISO, ...ea1],
  ),
    one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at < ? AND t.status IN ('todo','in_progress','changes_requested','approved')${employee ? " AND t.assignee_id=?" : ""}`, overdueArgs),
    fetchRaw(fromISO, toISO, employee, allTime),
    unknownDateCounts(employee),
  ]);
  const overdueCount = Number(overdueRow!.n);
  const m = aggregate(raw, fromISO, toISO, undefined, allTime ? "all" : "dated");
  const c: Record<string, number> = Object.fromEntries(counts.map((r) => [r.type, Number(r.n)]));


  const byStage = stageRows.filter((r) => r.active || Number(r.n) > 0).map((r) => ({ key: r.key, label: r.label, flag: r.flag, n: Number(r.n) }));


  const pending = { chief: 0, wisam: 0 };
  for (const p of pend) pending[p.requires as "chief" | "wisam"] = Number(p.n);


  // ---- "needs attention" data: everything below is live (as of now), not tied to the selected period ----
  const OPEN = "('todo','in_progress','changes_requested','approved')";
  const empT = employee ? " AND t.assignee_id=?" : "";
  const empA: InValue[] = employee ? [employee] : [];
  const nowISO = now();
  const d0 = localMidnight(todayYmd()).toISOString();
  const d1 = localMidnight(addDays(todayYmd(), 1)).toISOString();
  const d2 = localMidnight(addDays(todayYmd(), 2)).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const one_ = async (sql: string, a: InValue[]) => Number((await one(sql, a))!.n);
  // Replies nobody has answered yet (latest reply is newer than our latest outbound message), still-open leads, last 30 days.
  const scL = leadScope(actor);
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();

  // Open leads with nothing planned: no open task and no activity for 7+ days.

  // Team workload (managers see everyone; employees see themselves).

  const [dueToday, dueTomorrow, overdueOld, noDueDate, overdueByPerson, approvalAges, waitingOnApprovalTasks, unanswered, stale, staleCount, workload] = await Promise.all([
    one_(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at>=? AND t.due_at<? AND t.status IN ${OPEN}${empT}`, [d0, d1, ...empA]),
    one_(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at>=? AND t.due_at<? AND t.status IN ${OPEN}${empT}`, [d1, d2, ...empA]),
    one_(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at<? AND t.status IN ${OPEN}${empT}`, [week, ...empA]),
    one_(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.due_at IS NULL AND t.status IN ${OPEN}${empT}`, [...empA]),
    all(
    `SELECT u.id,u.name,COUNT(*) AS n,MIN(t.due_at) AS oldest FROM tasks t JOIN users u ON u.id=t.assignee_id
     WHERE t.is_demo=0 AND t.due_at<? AND t.status IN ${OPEN}${empT} GROUP BY u.id,u.name ORDER BY n DESC LIMIT 6`, [nowISO, ...empA]),
    all(`SELECT a.requires, MIN(a.created_at) AS oldest FROM approvals a WHERE a.is_demo=0 AND a.status='pending'${employee ? " AND a.submitted_by=?" : ""} GROUP BY a.requires`, empA),
    one_(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status='waiting_approval'${empT}`, [...empA]),
    all(
    `SELECT l.id,l.company,l.stage,r.at AS reply_at FROM leads l
     JOIN (SELECT lead_id, MAX(occurred_at) AS at FROM activities WHERE type='reply' AND is_demo=0 AND occurred_precision<>'unknown' GROUP BY lead_id) r ON r.lead_id=l.id
     WHERE l.is_demo=0 AND l.historical_only=0 AND r.at>=? AND ${scL.sql}${employee ? " AND l.owner_id=?" : ""}
       AND NOT EXISTS (SELECT 1 FROM activities m WHERE m.lead_id=l.id AND m.type='message' AND m.occurred_at>r.at)
       AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed','meeting'))
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')
     ORDER BY r.at ASC LIMIT 8`, [since30, ...scL.args, ...(employee ? [employee] : [])]),
    all(
    `SELECT l.id,l.company,l.stage,COALESCE(l.last_activity_at,l.created_at) AS last_at,u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
     WHERE l.is_demo=0 AND l.historical_only=0 AND ${scL.sql}${employee ? " AND l.owner_id=?" : ""}
       AND COALESCE(l.last_activity_at,l.created_at)<?
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND t.status IN ${OPEN.replace(")", ",'waiting_approval')")})
       AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed'))
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status IN ('opted_out','bounced') AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE c2.lead_id=l.id AND c2.email_status NOT IN ('opted_out','bounced')))
     ORDER BY last_at ASC LIMIT 8`, [...scL.args, ...(employee ? [employee] : []), week]),
    one_(
    `SELECT COUNT(*) AS n FROM leads l WHERE l.is_demo=0 AND l.historical_only=0 AND ${scL.sql}${employee ? " AND l.owner_id=?" : ""}
       AND COALESCE(l.last_activity_at,l.created_at)<?
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND t.status IN ${OPEN.replace(")", ",'waiting_approval')")})
       AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed'))`, [...scL.args, ...(employee ? [employee] : []), week]),
    all(
    `SELECT u.id,u.name,
       SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open_n,
       SUM(CASE WHEN t.status IN ${OPEN} AND t.due_at<? THEN 1 ELSE 0 END) AS overdue_n,
       SUM(CASE WHEN t.status IN ${OPEN} AND t.due_at>=? AND t.due_at<? THEN 1 ELSE 0 END) AS today_n,
       SUM(CASE WHEN t.status='waiting_approval' THEN 1 ELSE 0 END) AS waiting_n
     FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled')${empT}
     GROUP BY u.id,u.name ORDER BY overdue_n DESC, open_n DESC`, [nowISO, d0, d1, ...empA])
  ]);
  const oldestApproval: Record<string, string> = Object.fromEntries(approvalAges.map((r) => [r.requires, r.oldest]));


  return {
    attention: { dueToday, dueTomorrow, overdueOld, noDueDate, overdueByPerson, oldestApproval, waitingOnApprovalTasks, unanswered, stale, staleCount, workload: workload.map((w) => ({ id: w.id, name: w.name, open: Number(w.open_n), overdue: Number(w.overdue_n), today: Number(w.today_n), waiting: Number(w.waiting_n) })) },
    from, to, today, all: allTime, unknownCounts, employee: employee ?? null, m, counts: c, replies, byStage, overdueTasks, overdueCount,
    pending, pendingList, feed,
    firstBounceRate: rate(m.first_email_bounces, m.first_emails),
    followBounceRate: rate(m.follow_up_bounces, m.follow_ups),
  };
}

/* ---------- read API ---------- */
export const REPORT_RULES = {
  timezone: "Dates and day boundaries use APP_TIMEZONE (see `timezone`). A day runs from 00:00 to 24:00 local time; `to` is inclusive. A date-only event is stored as local midnight of that day.",
  views: "all=1 (since the beginning, plus a separate unknown-date row) · from=YYYY-MM-DD&to=YYYY-MM-DD (custom) · period=day|week|month&at=YYYY-MM-DD (the current bucket plus history).",
  event_dates: "Counted on the date it HAPPENED: leads on lead_date, sends/replies/stage changes on occurred_at, bounces on the bounce's own date, tasks on completed_at. Never on created_at (entry) or import time.",
  unknown_dates: "Records with an unknown date are in `unknown_counts` and, under all=1, in `totals` and the `unknown` row. They are never placed in a dated period or custom range.",
  employees: "Credited to the ORIGINAL employee (actor / created_by), never to whoever imported the record. Records whose original employee is unknown are in `totals` and listed as 'Unknown original employee' (id 0); filter with employee=unknown. Bounces are credited to the employee of the message that bounced.",
  sends: "first_emails = message records with kind first_email; follow_ups = kind follow_up; kind other is not counted in either. Counted by kind, whatever the channel.",
  replies: "replies = number of inbound reply records (not conversations). reply_leads = distinct leads with at least one reply in the period.",
  bounces: "first_email_bounces / follow_up_bounces are bounce EVENTS dated when the bounce happened (a bounce takes the kind of its message). Event-basis rate = bounces in the period ÷ sends in the period, so a late bounce lands in the later period and the rate can mix cohorts. *_cohort_bounces = messages SENT in the period that have a bounce (any date): the send-cohort view; cohort rate = cohort_bounces ÷ sends.",
  senders: "Filter with sender=<id|email>. Messages, replies and bounces are charged to the mailbox that sent the message (replies/bounces follow the message they answer; records from before senders existed belong to the default sender wisam.alaysa@conextek.com). With a sender filter, leads added, tasks completed and stage moves (meetings/won/lost) are not sender-based and are left out. `by_sender` splits the same period by mailbox.",
  excluded: "Test data (is_test) and historical-only (suppressed) entities as 'leads added' are excluded; replies/bounces recorded on historical-only entities still count on their dates.",
};

export async function reportApi(actor: Actor, p: { all?: boolean; from?: string; to?: string; period?: Granularity; at?: string; employee?: string | null; sender?: string | null }) {
  let sender: number | null = null;
  if (p.sender) {
    const sr = /^\d+$/.test(p.sender) ? await one("SELECT id FROM senders WHERE id=?", [Number(p.sender)]) : await one("SELECT id FROM senders WHERE lower(email)=lower(?)", [p.sender]);
    if (!sr) throw new HttpError(400, `sender: no sender "${p.sender}". Use an id or an email address (GET /senders).`);
    sender = sr.id as number;
  }
  const bySenderOut = (l: { sender_id: number; email: string; name: string; m: Metrics }[]) => l.map((x) => ({ sender_id: x.sender_id, email: x.email, name: x.name, ...x.m, ...rates(x.m) }));
  let emp: number | null = null;
  if (p.employee) {
    if (/^unknown$/i.test(p.employee)) emp = 0;
    else if (/^\d+$/.test(p.employee)) emp = Number(p.employee);
    else emp = ((await one("SELECT id FROM users WHERE lower(username)=lower(?)", [p.employee])) as { id: number } | null)?.id ?? -1;
    if (emp === -1) throw new HttpError(400, `employee: no user "${p.employee}". Use an id, a username, or "unknown".`);
  }
  const rates = (m: Metrics) => ({
    first_email_bounce_rate: rate(m.first_email_bounces, m.first_emails),
    follow_up_bounce_rate: rate(m.follow_up_bounces, m.follow_ups),
    first_email_cohort_bounce_rate: rate(m.first_email_cohort_bounces, m.first_emails),
    follow_up_cohort_bounce_rate: rate(m.follow_up_cohort_bounces, m.follow_ups),
  });
  if (p.all || p.from) {
    const r = await getRangeReport(actor, { all: p.all, from: p.from, to: p.to, employee: emp, sender });
    return { view: r.mode, from: p.all ? null : r.from, to: r.to, timezone: r.tz, breakdown: r.breakdown, employee: r.employee, sender: r.sender, by_sender: bySenderOut(r.bySender), totals: r.totals, rates: rates(r.totals), unknown: r.unknown, unknown_counts: r.unknownCounts, by_employee: r.byEmployee.map((e) => ({ employee_id: e.user.id, name: e.user.name, ...e.m })), buckets: r.buckets.map((b) => ({ label: b.label, from: b.from, to: b.to, ...b.m })), rules: REPORT_RULES };
  }
  const g = p.period && ["day", "week", "month"].includes(p.period) ? p.period : "day";
  const r = await getReport(actor, { granularity: g, at: p.at, employee: emp, sender });
  return { view: "period", period: g, at: r.at, timezone: r.tz, employee: r.employee, sender: r.sender, by_sender: bySenderOut(r.bySender), totals: r.totals, rates: rates(r.totals), unknown_counts: r.unknownCounts, by_employee: r.byEmployee.map((e) => ({ employee_id: e.user.id, name: e.user.name, ...e.m })), buckets: r.buckets.map((b) => ({ label: b.label, from: b.from, to: b.to, ...b.m })), rules: REPORT_RULES };
}
