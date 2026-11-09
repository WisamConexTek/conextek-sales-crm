import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, todayYmd, TZ, now, type Row } from "../db";
import { HttpError, can, isManager, type Actor } from "../auth";
import { liveTasks, STATES, type WorkState } from "./taskview";
export { STATES };
export type { WorkState };

/* ---------- Today / Tomorrow / any-date work view ---------- */

const isYmd = (v?: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * One row per task, placed on COALESCE(scheduled_at, due_at). `state`:
 *   completed (done/cancelled) > blocked (blockers recorded, or validation still needed) > overdue (time passed) > ready (prep_status = ready_for_execution) > planned.
 * `is_overdue` is also set on blocked rows. `ready` is a PREPARATION state only: it never means approved to contact.
 */
export type ScheduleFilters = { view?: "today" | "tomorrow"; date?: string; from?: string; to?: string; employee?: number; project?: number; campaign?: number; channel?: string; state?: string; includeTest?: boolean };

export async function schedule(actor: Actor, f: ScheduleFilters = {}) {
  const today = todayYmd();
  let from = isYmd(f.from) ? f.from : f.view === "tomorrow" ? addDays(today, 1) : isYmd(f.date) ? f.date : today;
  let to = isYmd(f.to) && f.to >= from ? f.to : from;
  if (f.state && !(STATES as readonly string[]).includes(f.state)) throw new HttpError(400, `state: one of ${STATES.join(", ")}.`);
  const fromISO = localMidnight(from).toISOString();
  const toISO = localMidnight(addDays(to, 1)).toISOString();
  const viewAll = can(actor, "tasks.view_all") || isManager(actor);
  const where = ["COALESCE(t.scheduled_at,t.due_at)>=?", "COALESCE(t.scheduled_at,t.due_at)<?"];
  const args: InValue[] = [fromISO, toISO];
  const emp = viewAll ? f.employee : actor.id;
  if (emp) (where.push("t.assignee_id=?"), args.push(emp));
  if (f.campaign) (where.push("t.campaign_id=?"), args.push(f.campaign));
  if (f.project) (where.push("c.project_id=?"), args.push(f.project));
  if (f.channel) (where.push("t.channel=?"), args.push(f.channel));
  if (!f.includeTest) where.push("t.is_demo=0");
  const rows = await all(
    `SELECT t.id,t.title,t.status,t.task_type,t.action_type,t.channel,t.prep_status,t.blockers,t.scheduled_at,t.scheduled_input,t.due_at,t.lead_id,t.assignee_id,t.campaign_id,t.is_demo,t.message_version_id,t.sent_at,t.activity_id,t.completed_at,t.due_on,t.scheduled_on,t.hold_reason,
            COALESCE(t.scheduled_at,t.due_at) AS at, CASE WHEN t.scheduled_at IS NOT NULL THEN 'scheduled_at' ELSE 'due_at' END AS at_source,
            u.name AS employee, c.name AS campaign, p.name AS project, l.company,
            (SELECT ct.name FROM contacts ct WHERE ct.lead_id=t.lead_id ORDER BY ct.is_primary DESC, ct.id LIMIT 1) AS contact,
            (SELECT COUNT(*) FROM contacts ct WHERE ct.lead_id=t.lead_id AND ct.email_status='opted_out') AS opted_out
     FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id
     LEFT JOIN campaigns c ON c.id=t.campaign_id LEFT JOIN projects p ON p.id=c.project_id
     WHERE ${where.join(" AND ")} ORDER BY COALESCE(t.scheduled_at,t.due_at), t.id LIMIT 500`, args);
  const out = (await liveTasks(rows)).map((r) => ({ ...r, at: r.date_only ? null : r.at }) as typeof r);
  const filtered = f.state ? out.filter((r) => r.state === f.state) : out;
  const counts = Object.fromEntries(STATES.map((s) => [s, out.filter((r) => r.state === s).length]));
  return { timezone: TZ(), from, to, counts, total: filtered.length, rows: filtered };
}

/* ---------- Campaign reporting ---------- */

export const CAMPAIGN_REPORT_RULES = {
  attribution: "An activity belongs to a campaign if the lead was a member of it at that time. The original membership also covers activity from before it was recorded. Activity with an unknown date is never attributed.",
  planned_vs_done: "Planned = open tasks with a schedule. Done counts only recorded sends/replies. Drafts, internal approvals, public social engagement and silence are never counted as sends, authorizations or rejections.",
  rates: "Every rate lists its numerator and denominator. reply_rate = leads that replied ÷ leads that received a first email. first_email_bounce_rate = first emails that bounced ÷ first emails sent. Silence is not a rejection: no rate counts it.",
  positive_replies: "Proxy: leads that replied and now sit in Interested, Meeting, Trial or Won. Replies are not individually classified yet.",
  approved_scheduled: "Open tasks scheduled in the future that have an active Owner send authorization for their message version.",
  test_data: "Test data is excluded. Historical-only leads are counted in unique_leads_historical_only, and their replies and sends still count on their own dates.",
};

const rateOf = (n: number, d: number) => ({ numerator: n, denominator: d, value: d ? n / d : null });

export async function campaignReport(actor: Actor, campaignId?: number) {
  if (!can(actor, "reports.view") && !isManager(actor)) throw new HttpError(403, "Campaign reports are for managers.");
  const camps = await all(`SELECT c.id,c.key,c.name,c.status,c.objective,c.target_markets,p.name AS project,u.name AS owner_name FROM campaigns c JOIN projects p ON p.id=c.project_id LEFT JOIN users u ON u.id=c.owner_id ${campaignId ? "WHERE c.id=?" : ""} ORDER BY c.id`, campaignId ? [campaignId] : []);
  if (campaignId && !camps.length) throw new HttpError(404, "Campaign not found.");
  const n = async (sql: string, a: InValue[]) => Number((await one(sql, a))!.n);
  const join = `FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id AND l.is_demo=0
    JOIN activities a ON a.lead_id=lc.lead_id AND a.is_demo=0 AND a.occurred_precision<>'unknown'
      AND (lc.is_original=1 OR a.occurred_at>=lc.joined_at) AND (lc.ended_at IS NULL OR a.occurred_at<lc.ended_at)
    WHERE lc.campaign_id=?`;
  const nowISO = now();
  type CampRow = Row & { id: number; name: string; status: string; project: string; owner_name: string | null; target_markets: string | null; objective: string | null; unique_leads: number; unique_leads_historical_only: number; preparation_backlog: number; approved_scheduled: number; planned_tasks: number; completed_tasks: number; first_emails: number; follow_ups: number; leads_emailed: number; replies: number; reply_leads: number; positive_reply_leads: number; meetings: number; won: number; lost: number; closed: number; rates: Record<string, ReturnType<typeof rateOf>> };
  const result: CampRow[] = [];
  for (const c of camps) {
    const id = c.id as number;
    const uniq = await n("SELECT COUNT(DISTINCT lc.lead_id) AS n FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id WHERE lc.campaign_id=? AND lc.status='active' AND l.is_demo=0", [id]);
    const hist = await n("SELECT COUNT(DISTINCT lc.lead_id) AS n FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id WHERE lc.campaign_id=? AND lc.status='active' AND l.is_demo=0 AND l.historical_only=1", [id]);
    const firstEmails = await n(`SELECT COUNT(*) AS n ${join} AND a.type='message' AND a.message_kind='first_email'`, [id]);
    const followUps = await n(`SELECT COUNT(*) AS n ${join} AND a.type='message' AND a.message_kind='follow_up'`, [id]);
    const leadsEmailed = await n(`SELECT COUNT(DISTINCT lc.lead_id) AS n ${join} AND a.type='message' AND a.message_kind='first_email'`, [id]);
    const bounced = await n(`SELECT COUNT(*) AS n ${join} AND a.type='message' AND a.message_kind='first_email' AND EXISTS (SELECT 1 FROM activities b WHERE b.parent_id=a.id AND b.outcome='bounced')`, [id]);
    const replies = await n(`SELECT COUNT(*) AS n ${join} AND a.type='reply'`, [id]);
    const replyLeads = await n(`SELECT COUNT(DISTINCT lc.lead_id) AS n ${join} AND a.type='reply'`, [id]);
    const positive = await n(`SELECT COUNT(DISTINCT lc.lead_id) AS n ${join} AND a.type='reply' AND (l.stage IN ('interested','meeting','trial','won') OR EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('meeting','won')))`, [id]);
    const stageCount = (flag: string) => n("SELECT COUNT(DISTINCT lc.lead_id) AS n FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id JOIN lists s ON s.kind='stage' AND s.key=l.stage WHERE lc.campaign_id=? AND lc.status='active' AND l.is_demo=0 AND s.flag=?", [id, flag]);
    const OPEN = "t.status IN ('todo','in_progress','changes_requested','approved','waiting_approval')";
    const backlog = await n(`SELECT COUNT(*) AS n FROM tasks t WHERE t.campaign_id=? AND t.is_demo=0 AND ${OPEN} AND (t.prep_status IS NULL OR t.prep_status<>'ready_for_execution')`, [id]);
    const approved = await n(`SELECT COUNT(*) AS n FROM tasks t WHERE t.campaign_id=? AND t.is_demo=0 AND ${OPEN} AND t.scheduled_at>=? AND EXISTS (SELECT 1 FROM message_versions v JOIN send_authorizations a ON a.message_version_id=v.id WHERE v.task_id=t.id AND a.kind='send' AND a.status='active')`, [id, nowISO]);
    const planned = await n(`SELECT COUNT(*) AS n FROM tasks t WHERE t.campaign_id=? AND t.is_demo=0 AND ${OPEN} AND t.scheduled_at IS NOT NULL`, [id]);
    const completedTasks = await n("SELECT COUNT(*) AS n FROM tasks t WHERE t.campaign_id=? AND t.is_demo=0 AND t.status='completed'", [id]);
    result.push({
      ...c, unique_leads: uniq, unique_leads_historical_only: hist,
      preparation_backlog: backlog, approved_scheduled: approved, planned_tasks: planned, completed_tasks: completedTasks,
      first_emails: firstEmails, follow_ups: followUps, leads_emailed: leadsEmailed, replies, reply_leads: replyLeads, positive_reply_leads: positive,
      meetings: await stageCount("meeting"), won: await stageCount("won"), lost: await stageCount("lost"), closed: await stageCount("closed"),
      rates: { reply_rate: rateOf(replyLeads, leadsEmailed), first_email_bounce_rate: rateOf(bounced, firstEmails), positive_reply_rate: rateOf(positive, replyLeads) },
    } as unknown as CampRow);
  }
  const unassigned = await n("SELECT COUNT(*) AS n FROM leads l WHERE l.is_demo=0 AND l.historical_only=0 AND NOT EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.status='active')", []);
  return { campaigns: result, unassigned_leads: unassigned, rules: CAMPAIGN_REPORT_RULES };
}

/** The lead page's operational summary: where it belongs, last communication, next work, blockers. */
export async function leadOperations(actor: Actor, leadId: number) {
  const next = await one(
    `SELECT t.id,t.title,t.channel,t.action_type,t.prep_status,t.blockers,t.status,t.message_version_id,t.assignee_id,u.name AS employee,t.campaign_id,COALESCE(t.scheduled_at,t.due_at) AS at,t.scheduled_at
     FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.lead_id=? AND t.status NOT IN ('completed','cancelled') ORDER BY (COALESCE(t.scheduled_at,t.due_at) IS NULL), COALESCE(t.scheduled_at,t.due_at) LIMIT 1`, [leadId]);
  const last = await one("SELECT a.id,a.type,a.message_kind,a.channel,a.outcome,a.title,a.occurred_at,a.occurred_precision FROM activities a WHERE a.lead_id=? AND a.type IN ('message','reply') AND a.is_demo=0 ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1", [leadId]);
  const restr = await all("SELECT name,email_status FROM contacts WHERE lead_id=? AND email_status IN ('opted_out','bounced')", [leadId]);
  const pend = await one("SELECT COUNT(*) AS n FROM send_events WHERE lead_id=? AND status='SENT_CONFIRMED_CRM_PENDING'", [leadId]);
  const auths = await one("SELECT COUNT(*) AS n FROM send_authorizations WHERE lead_id=? AND kind='send' AND status='active'", [leadId]);
  let nextTask = next as Row | null;
  if (nextTask?.message_version_id) {
    const [lt] = await liveTasks([nextTask]);
    nextTask = { ...nextTask, prep_status: lt.prep_status, blockers: lt.blockers, prep_label: lt.prep_label } as Row;
  }
  void actor;
  return { next_task: nextTask, last_communication: (last as Row | null), restrictions: restr, crm_pending_sends: Number(pend!.n), active_send_authorizations: Number(auths!.n) };
}
