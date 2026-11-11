import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, todayYmd } from "../db";
import { can, isManager, type Actor } from "../auth";
import { cached } from "../ttl-cache";
import { leadScope, quietLeadFilter, unansweredReplyFilter } from "./leads";
import { liveTasks, type LiveTask, type WorkState } from "./taskview";
import { getRangeReport, scopeEmployee, rate, type Metrics } from "./reports";
import { canAuthorizeSend, countPendingSendApprovals, pendingSendApprovalsByCampaign } from "./sends";
import { capacityFor } from "./capacity";
import { sendersHealth } from "./senders";
import { recentApiActivity } from "./agents";

/**
 * The dashboard's data layer.
 *
 * Design rules:
 *  - One loader per dashboard section. Sections load independently (the page streams them), so a slow or
 *    failing section never holds back or breaks the others.
 *  - One definition per number. Task states come from liveTasks (the same code as Today & Tomorrow, the task
 *    page and the API); "reply not answered" and "nothing planned" come from the shared lead filters, which the
 *    Leads page uses too. A counter therefore always opens exactly the records it counted.
 *  - "Now" sections are live and ignore the selected period. Only Results and the campaign activity columns
 *    follow the period, and they count on event dates (see reports.ts).
 *  - Every loader is cached for a few seconds per person + filter; web actions clear the cache.
 */

const TTL = 5000;
const isYmd = (v?: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/* ---------- who is looking, and at whom ---------- */
export type Scope = {
  /** May see the whole team's numbers. */
  teamView: boolean;
  manager: boolean;
  /** Person the numbers are narrowed to (always the viewer for people without team rights). */
  employee: number | undefined;
  /** What the viewer asked for in the filter (reports apply their own access rule to it). */
  requested: number | undefined;
  /** Person the task board is narrowed to (task visibility has its own permission). */
  taskEmployee: number | undefined;
  key: string;
};
export function dashScope(actor: Actor, requested?: number): Scope {
  const manager = isManager(actor);
  const teamView = can(actor, "reports.view") || manager;
  const employee = scopeEmployee(actor, requested) || undefined;
  const taskEmployee = can(actor, "tasks.view_all") || manager ? employee : actor.id;
  return { teamView, manager, employee, requested, taskEmployee, key: `${actor.id}:${employee ?? "all"}:${taskEmployee ?? "all"}` };
}

/* ---------- the selected period ---------- */
export type Period = {
  all: boolean; from: string; to: string; days: number; label: string;
  preset: "today" | "7d" | "30d" | "all" | "custom";
  /** The period of the same length just before this one (for "vs previous"). */
  prev: { from: string; to: string } | null;
  key: string;
};
export function resolvePeriod(o: { from?: string; to?: string; all?: boolean }): Period {
  const today = todayYmd();
  if (o.all) return { all: true, from: today, to: today, days: 0, label: "All data", preset: "all", prev: null, key: "all" };
  const from = isYmd(o.from) ? o.from : addDays(today, -6);
  const to = isYmd(o.to) && o.to >= from ? o.to : isYmd(o.from) ? from : today;
  const days = dayDiff(from, to) + 1;
  const preset = to !== today ? "custom" : days === 1 ? "today" : days === 7 ? "7d" : days === 30 ? "30d" : "custom";
  const label = preset === "today" ? "Today" : preset === "7d" ? "Last 7 days" : preset === "30d" ? "Last 30 days"
    : from === to ? (from === addDays(today, -1) ? "Yesterday" : from) : `${from} → ${to}`;
  return { all: false, from, to, days, label, preset, prev: { from: addDays(from, -days), to: addDays(from, -1) }, key: `${from}:${to}` };
}

/* ---------- 1. the task board: one live definition of overdue / blocked / ready ---------- */
export type BoardItem = LiveTask & { when: "earlier" | "today" | "tomorrow" };
export type Workload = { id: number; name: string; open: number; waiting: number; overdue: number; blocked: number; ready: number };
const STATE_ORDER: Record<WorkState, number> = { overdue: 0, ready: 1, blocked: 2, planned: 3, completed: 4 };

/** Every open task whose time is before the end of tomorrow (so: everything late, plus today and tomorrow), with its LIVE state. */
export function loadBoard(actor: Actor, sc: Scope) {
  return cached(`dash:board:${sc.key}`, TTL, async () => {
    const today = todayYmd();
    const d0 = localMidnight(today).toISOString();
    const d1 = localMidnight(addDays(today, 1)).toISOString();
    const d2 = localMidnight(addDays(today, 2)).toISOString();
    const emp = sc.taskEmployee;
    const empSql = emp ? " AND t.assignee_id=?" : "";
    const empArgs: InValue[] = emp ? [emp] : [];
    const LIMIT = 500;
    const [rows, people, doneRow, noDateRow] = await Promise.all([
      all(
        `SELECT t.id,t.title,t.status,t.task_type,t.action_type,t.channel,t.prep_status,t.blockers,t.scheduled_at,t.due_at,t.lead_id,t.assignee_id,t.campaign_id,
                t.message_version_id,t.sent_at,t.activity_id,t.completed_at,t.due_on,t.scheduled_on,t.hold_reason,t.rescheduled_from,
                COALESCE(t.scheduled_at,t.due_at) AS sort_at, u.name AS employee, c.name AS campaign, l.company
         FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN campaigns c ON c.id=t.campaign_id
         WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') AND COALESCE(t.scheduled_at,t.due_at)<?${empSql}
         ORDER BY COALESCE(t.scheduled_at,t.due_at), t.id LIMIT ${LIMIT}`, [d2, ...empArgs]),
      all(
        `SELECT u.id,u.name,COUNT(*) AS open_n,SUM(CASE WHEN t.status='waiting_approval' THEN 1 ELSE 0 END) AS waiting_n
         FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled')${empSql} GROUP BY u.id,u.name`, empArgs),
      one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status='completed' AND t.completed_at>=? AND t.completed_at<?${empSql}`, [d0, d1, ...empArgs]),
      one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') AND t.scheduled_at IS NULL AND t.due_at IS NULL${empSql}`, empArgs),
    ]);
    const live = (await liveTasks(rows)).map((r) => ({ ...r, when: r.sort_at < d0 ? "earlier" : r.sort_at < d1 ? "today" : "tomorrow" }) as BoardItem);
    const zero = () => ({ overdue: 0, blocked: 0, ready: 0, planned: 0 });
    const counts = zero(), todayCounts = zero(), tomorrowCounts = zero();
    const per = new Map<number, { overdue: number; blocked: number; ready: number }>();
    for (const r of live) {
      const s = r.state as "overdue" | "blocked" | "ready" | "planned";
      if (!(s in counts)) continue;
      counts[s]++;
      if (r.when === "today") todayCounts[s]++;
      if (r.when === "tomorrow") tomorrowCounts[s]++;
      const p = per.get(r.assignee_id) ?? per.set(r.assignee_id, { overdue: 0, blocked: 0, ready: 0 }).get(r.assignee_id)!;
      if (s !== "planned") p[s]++;
    }
    const workload: Workload[] = people
      .map((p) => ({ id: p.id as number, name: p.name as string, open: Number(p.open_n), waiting: Number(p.waiting_n), ...(per.get(p.id as number) ?? { overdue: 0, blocked: 0, ready: 0 }) }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open);
    const oldestOverdue = live.find((r) => r.state === "overdue")?.sort_at as string | undefined;
    const items = [...live].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.sort_at < b.sort_at ? -1 : 1)).slice(0, 10);
    return {
      counts, today: todayCounts, tomorrow: tomorrowCounts, total: live.length, items, workload, oldestOverdue: oldestOverdue ?? null,
      completedToday: Number(doneRow!.n), noDate: Number(noDateRow!.n), truncated: rows.length === LIMIT,
    };
  });
}
export type Board = Awaited<ReturnType<typeof loadBoard>>;

/* ---------- 2. decisions and leads that wait on someone ---------- */
export function loadActions(actor: Actor, sc: Scope) {
  return cached(`dash:actions:${sc.key}`, TTL, async () => {
    const canSend = await canAuthorizeSend(actor);
    const decides = can(actor, "approvals.decide");
    const n = async (sql: string, a: InValue[] = []) => Number((await one(sql, a))!.n);
    const [sendApprovals, toDecide, oldestToDecide, mineWaiting, changesRequested, crmPending] = await Promise.all([
      canSend ? countPendingSendApprovals() : Promise.resolve(null),
      // Same rule as the menu badge: approvals this person can decide (a Chief never decides Wisam-only items, nobody decides their own).
      decides ? n(`SELECT COUNT(*) AS n FROM approvals WHERE is_demo=0 AND status='pending' AND submitted_by<>?${actor.role === "owner" ? "" : " AND requires='chief'"}`, [actor.id]) : Promise.resolve(null),
      decides ? one(`SELECT MIN(created_at) AS at FROM approvals WHERE is_demo=0 AND status='pending' AND submitted_by<>?${actor.role === "owner" ? "" : " AND requires='chief'"}`, [actor.id]) : Promise.resolve(null),
      n("SELECT COUNT(*) AS n FROM approvals WHERE is_demo=0 AND status='pending' AND submitted_by=?", [actor.id]),
      n(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status='changes_requested'${sc.taskEmployee ? " AND t.assignee_id=?" : ""}`, sc.taskEmployee ? [sc.taskEmployee] : []),
      sc.manager ? n("SELECT COUNT(*) AS n FROM send_events e JOIN leads l ON l.id=e.lead_id WHERE e.status='SENT_CONFIRMED_CRM_PENDING' AND l.is_demo=0") : Promise.resolve(0),
    ]);
    return { canSend, sendApprovals, toDecide, oldestToDecide: (oldestToDecide?.at as string | null) ?? null, mineWaiting, changesRequested, crmPending };
  });
}

/** Leads that need a person: replies nobody answered, open leads with nothing planned, and the latest replies. */
export function loadAttention(actor: Actor, sc: Scope) {
  return cached(`dash:attention:${sc.key}`, TTL, async () => {
    const s = leadScope(actor);
    const own = sc.employee ? " AND l.owner_id=?" : "";
    const ownArgs: InValue[] = sc.employee ? [sc.employee] : [];
    const un = unansweredReplyFilter();
    const qu = quietLeadFilter();
    const [unansweredRow, unanswered, quietRow, quiet, replies] = await Promise.all([
      one(`SELECT COUNT(*) AS n FROM leads l WHERE ${s.sql} AND ${un.sql}${own}`, [...s.args, ...un.args, ...ownArgs]),
      all(`SELECT l.id,l.company,${un.replyAt} AS reply_at,u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
           WHERE ${s.sql} AND ${un.sql}${own} ORDER BY reply_at ASC LIMIT 6`, [...s.args, ...un.args, ...ownArgs]),
      one(`SELECT COUNT(*) AS n FROM leads l WHERE ${s.sql} AND ${qu.sql}${own}`, [...s.args, ...qu.args, ...ownArgs]),
      all(`SELECT l.id,l.company,COALESCE(l.last_activity_at,l.created_at) AS last_at,u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
           WHERE ${s.sql} AND ${qu.sql}${own} ORDER BY last_at ASC LIMIT 6`, [...s.args, ...qu.args, ...ownArgs]),
      all(`SELECT a.id,a.lead_id,a.occurred_at,a.title,a.body,a.classification,l.company FROM activities a JOIN leads l ON l.id=a.lead_id
           WHERE a.is_demo=0 AND a.type='reply' AND a.occurred_precision<>'unknown' AND ${s.sql}${own} ORDER BY a.occurred_at DESC LIMIT 5`, [...s.args, ...ownArgs]),
    ]);
    return { unansweredCount: Number(unansweredRow!.n), unanswered, quietCount: Number(quietRow!.n), quiet, replies };
  });
}

/* ---------- 3. sending today: capacity and health per mailbox (managers) ---------- */
export function loadSending() {
  return cached("dash:sending", TTL, async () => {
    const [cap, health] = await Promise.all([capacityFor(), sendersHealth()]);
    const h = new Map(health.map((x) => [x.sender_id, x]));
    return {
      date: cap.date,
      pushedTotal: cap.pushed_to_next_day.length,
      senders: cap.senders.map((s) => {
        const x = h.get(s.sender_id);
        return {
          id: s.sender_id, name: s.display_name, email: s.email, status: s.status as "active" | "warming_up" | "paused" | "inactive",
          cap: s.daily_cap, unlimited: s.unlimited, used: s.used, reserved: s.reserved, remaining: s.remaining, pushed: s.pushed_to_next_day.length,
          warmup: !!s.warmup, warmupNotStarted: !!s.warmup_not_started,
          sent7: x?.sent_7d ?? 0, bounces7: x?.bounces_7d ?? 0, bounceRate7: x?.bounce_rate_7d ?? null, replies7: x?.replies_7d ?? 0, complaints7: x?.complaints_7d ?? 0,
          paused: x?.paused ?? null,
        };
      }),
    };
  });
}
export type Sending = Awaited<ReturnType<typeof loadSending>>;

/* ---------- 4. results for the selected period, with the period before it ---------- */
export function loadResults(actor: Actor, sc: Scope, p: Period) {
  return cached(`dash:results:${sc.key}:${p.key}`, TTL, async () => {
    const [cur, prev] = await Promise.all([
      getRangeReport(actor, { all: p.all, from: p.from, to: p.to, employee: sc.requested }),
      p.prev ? getRangeReport(actor, { from: p.prev.from, to: p.prev.to, employee: sc.requested }) : Promise.resolve(null),
    ]);
    const rates = (m: Metrics) => ({ firstBounce: rate(m.first_email_bounces, m.first_emails), followBounce: rate(m.follow_up_bounces, m.follow_ups) });
    return {
      totals: cur.totals, rates: rates(cur.totals),
      prev: prev ? { totals: prev.totals, rates: rates(prev.totals) } : null,
      breakdown: cur.breakdown, buckets: cur.buckets.map((b) => ({ start: b.start, label: b.label, m: b.m })),
      byEmployee: cur.byEmployee.map((e) => ({ id: e.user.id as number, name: e.user.name as string, m: e.m })),
      unknownCounts: cur.unknownCounts,
    };
  });
}
export type Results = Awaited<ReturnType<typeof loadResults>>;

/* ---------- 5. pipeline: where the leads are, by stage and by campaign ---------- */
export function loadPipeline(actor: Actor, sc: Scope, p: Period) {
  return cached(`dash:pipeline:${sc.key}:${p.key}`, TTL, async () => {
    const s = leadScope(actor);
    const own = sc.employee ? " AND l.owner_id=?" : "";
    const stagesP = all(
      `SELECT s.key,s.label,s.flag,s.active,
         (SELECT COUNT(*) FROM leads l WHERE l.stage=s.key AND l.is_demo=0 AND l.historical_only=0 AND ${s.sql}${own}) AS n
       FROM lists s WHERE s.kind='stage' ORDER BY s.position,s.id`, [...s.args, ...(sc.employee ? [sc.employee] : [])]);
    if (!sc.teamView) {
      const stages = (await stagesP).filter((r) => r.active || Number(r.n) > 0).map((r) => ({ key: r.key as string, label: r.label as string, flag: r.flag as string | null, retired: !r.active, n: Number(r.n) }));
      return { stages, campaigns: null, unassigned: 0 };
    }
    const fromISO = p.all ? "0000-01-01T00:00:00.000Z" : localMidnight(p.from).toISOString();
    const toISO = p.all ? "9999-12-31T00:00:00.000Z" : localMidnight(addDays(p.to, 1)).toISOString();
    const [stageRows, camps, act, waiting, unassignedRow] = await Promise.all([
      stagesP,
      all(
        `SELECT c.id,c.name,c.status,
           (SELECT COUNT(DISTINCT lc.lead_id) FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id WHERE lc.campaign_id=c.id AND lc.status='active' AND l.is_demo=0 AND l.historical_only=0) AS leads,
           (SELECT COUNT(*) FROM tasks t WHERE t.campaign_id=c.id AND t.is_demo=0 AND t.status NOT IN ('completed','cancelled')) AS open_tasks
         FROM campaigns c WHERE c.status<>'closed' ORDER BY c.id`),
      // Same attribution rule as the campaign report: an activity belongs to the campaign the lead was in at that time.
      all(
        `SELECT lc.campaign_id AS cid,
           SUM(CASE WHEN a.type='message' AND a.message_kind='first_email' THEN 1 ELSE 0 END) AS first_emails,
           SUM(CASE WHEN a.type='message' AND a.message_kind='follow_up' THEN 1 ELSE 0 END) AS follow_ups,
           COUNT(DISTINCT CASE WHEN a.type='message' AND a.message_kind='first_email' THEN lc.lead_id END) AS leads_emailed,
           COUNT(DISTINCT CASE WHEN a.type='reply' THEN lc.lead_id END) AS reply_leads,
           SUM(CASE WHEN a.type='message' AND a.message_kind='first_email' AND EXISTS (SELECT 1 FROM activities b WHERE b.parent_id=a.id AND b.outcome='bounced') THEN 1 ELSE 0 END) AS first_bounced
         FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id AND l.is_demo=0
         JOIN activities a ON a.lead_id=lc.lead_id AND a.is_demo=0 AND a.occurred_precision<>'unknown'
           AND (lc.is_original=1 OR a.occurred_at>=lc.joined_at) AND (lc.ended_at IS NULL OR a.occurred_at<lc.ended_at)
         WHERE a.type IN ('message','reply') AND a.occurred_at>=? AND a.occurred_at<? GROUP BY lc.campaign_id`, [fromISO, toISO]),
      pendingSendApprovalsByCampaign(),
      one("SELECT COUNT(*) AS n FROM leads l WHERE l.is_demo=0 AND l.historical_only=0 AND NOT EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.status='active')"),
    ]);
    const a = new Map(act.map((r) => [r.cid as number, r]));
    const stages = stageRows.filter((r) => r.active || Number(r.n) > 0).map((r) => ({ key: r.key as string, label: r.label as string, flag: r.flag as string | null, retired: !r.active, n: Number(r.n) }));
    const campaigns = camps.map((c) => {
      const x = a.get(c.id as number);
      const firstEmails = Number(x?.first_emails ?? 0), emailed = Number(x?.leads_emailed ?? 0), replyLeads = Number(x?.reply_leads ?? 0);
      return {
        id: c.id as number, name: c.name as string, status: c.status as string, leads: Number(c.leads), openTasks: Number(c.open_tasks),
        waitingSendApproval: waiting.get(c.id as number) ?? 0,
        firstEmails, followUps: Number(x?.follow_ups ?? 0), replyLeads,
        replyRate: rate(replyLeads, emailed), firstBounceRate: rate(Number(x?.first_bounced ?? 0), firstEmails),
      };
    });
    return { stages, campaigns, unassigned: Number(unassignedRow!.n) };
  });
}
export type Pipeline = Awaited<ReturnType<typeof loadPipeline>>;

/* ---------- 6. what just happened: the work feed and every step agents took through the API ---------- */

export function loadFeed(actor: Actor, sc: Scope) {
  return cached(`dash:feed:${sc.key}`, TTL, async () => {
    const s = leadScope(actor);
    const by = sc.employee ? " AND a.actor_id=?" : "";
    const feedP = all(
      `SELECT a.id,a.lead_id,a.type,a.message_kind,a.title,a.occurred_at,l.company,COALESCE(u.name,'Unknown original employee') AS actor_name
       FROM activities a JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=a.actor_id
       WHERE a.is_demo=0 AND a.occurred_precision<>'unknown' AND ${s.sql}${by} ORDER BY a.occurred_at DESC, a.id DESC LIMIT 10`,
      [...s.args, ...(sc.employee ? [sc.employee] : [])]);
    if (!sc.manager) return { feed: await feedP, api: null };
    const [feed, api] = await Promise.all([feedP, recentApiActivity(10)]);
    return { feed, api };
  });
}
