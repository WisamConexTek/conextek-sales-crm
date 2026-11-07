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

/** Everything below is computed from actually-logged rows only. Demo rows are always excluded. */
async function fetchRaw(fromISO: string, toISO: string, employee?: number): Promise<Raw> {
  const e = employee ? [employee] : [];
  const acts = await all(
    `SELECT a.type,a.message_kind,a.outcome,a.actor_id,a.occurred_at,sl.flag AS stage_flag,
            EXISTS(SELECT 1 FROM activities b WHERE b.parent_id=a.id AND b.outcome='bounced') AS bounced
     FROM activities a LEFT JOIN lists sl ON sl.kind='stage' AND sl.key=a.stage_to
     WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<? AND a.type IN ('message','reply','status')
     ${employee ? "AND a.actor_id=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  const leads = await all(
    `SELECT created_by AS uid, created_at AS at FROM leads WHERE is_demo=0 AND created_at>=? AND created_at<? ${employee ? "AND created_by=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  const tasks = await all(
    `SELECT assignee_id AS uid, completed_at AS at FROM tasks WHERE is_demo=0 AND status='completed' AND completed_at>=? AND completed_at<? ${employee ? "AND assignee_id=?" : ""}`,
    [fromISO, toISO, ...e],
  );
  return { acts, leads, tasks };
}

function aggregate(raw: Raw, fromISO: string, toISO: string, uid?: number): Metrics {
  const m = zero();
  const inr = (t: string) => t >= fromISO && t < toISO;
  for (const a of raw.acts) {
    if (!inr(a.occurred_at) || (uid && a.actor_id !== uid)) continue;
    if (a.type === "message" && a.outcome === "sent") {
      if (a.message_kind === "first_email") (m.first_emails++, (m.first_email_bounces += a.bounced ? 1 : 0));
      else if (a.message_kind === "follow_up") (m.follow_ups++, (m.follow_up_bounces += a.bounced ? 1 : 0));
    } else if (a.type === "reply") m.replies++;
    else if (a.type === "status") {
      if (a.stage_flag === "meeting") m.meetings++;
      else if (a.stage_flag === "won") m.won++;
      else if (a.stage_flag === "lost") m.lost++;
    }
  }
  for (const l of raw.leads) if (inr(l.at) && (!uid || l.uid === uid)) m.leads_added++;
  for (const t of raw.tasks) if (inr(t.at) && (!uid || t.uid === uid)) m.completed++;
  return m;
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
    prevStart: prevStart(starts[0], g), nextStart: endYmd, byEmployee, totals, totalOverdue,
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
export async function getDashboard(actor: Actor, opts: { from?: string; to?: string; employee?: number | null }) {
  const employee = scopeEmployee(actor, opts.employee);
  const today = todayYmd();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : today;
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) && opts.to >= from ? opts.to : from;
  const fromISO = localMidnight(from).toISOString();
  const toISO = localMidnight(addDays(to, 1)).toISOString();

  const raw = await fetchRaw(fromISO, toISO, employee);
  const m = aggregate(raw, fromISO, toISO);

  const ea = employee ? " AND a.actor_id=?" : "";
  const ea1: InValue[] = employee ? [employee] : [];
  const counts = await all(
    `SELECT a.type, COUNT(*) AS n FROM activities a WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<? AND a.type IN ('research','draft','note','status')${ea} GROUP BY a.type`,
    [fromISO, toISO, ...ea1],
  );
  const c: Record<string, number> = Object.fromEntries(counts.map((r) => [r.type, Number(r.n)]));

  const replies = await all(
    `SELECT a.id,a.lead_id,a.occurred_at,a.title,a.body,l.company,u.name AS actor_name
     FROM activities a JOIN leads l ON l.id=a.lead_id JOIN users u ON u.id=a.actor_id
     WHERE a.is_demo=0 AND a.type='reply' AND a.occurred_at>=? AND a.occurred_at<?${ea} ORDER BY a.occurred_at DESC LIMIT 8`,
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
     WHERE a.is_demo=0 AND a.occurred_at>=? AND a.occurred_at<?${ea} ORDER BY a.occurred_at DESC LIMIT 12`,
    [fromISO, toISO, ...ea1],
  );

  return {
    from, to, today, employee: employee ?? null, m, counts: c, replies, byStage, overdueTasks, overdueCount,
    pending, pendingList, feed,
    firstBounceRate: rate(m.first_email_bounces, m.first_emails),
    followBounceRate: rate(m.follow_up_bounces, m.follow_ups),
  };
}
