import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, todayYmd, TZ, now, type Row } from "../db";
import { HttpError, can, isManager, type Actor } from "../auth";
import { GUIDE_VERSION } from "../agent-guide";
import { leadScope } from "./leads";
import { liveTasks } from "./taskview";
import { toLocalInput } from "../format";
import { getVersion, checkEligibility } from "./sends";
import { displayType } from "./tasklist";
import { parseLabels, ensureReplyFollowUps } from "./sequences";
import { syncShortfalls } from "./workplan";

/**
 * Two calls that replace most of an agent's stitching:
 *   nextWork     - "what should I do now?": the work list with the lead, contact, draft, approvals and eligibility attached,
 *                  and for each item the one next step in plain words.
 *   changesSince - "what happened since my last run?": decisions on my drafts, new approvals, replies, bounces, task changes.
 * Both only read. They apply the same access rules as the calls they stand in for.
 */

type Action = "send" | "draft" | "work" | "wait" | "fix";
const ACTIONS: Action[] = ["send", "draft", "work", "wait", "fix"];
type Urgency = "overdue" | "today" | "tomorrow" | "undated";
const URGENCY: Record<Urgency, number> = { overdue: 0, today: 1, tomorrow: 2, undated: 3 };
const isOutreach = (t: Row) => /send|email|follow|outreach|message|linkedin/i.test(`${t.action_type ?? ""} ${t.task_type ?? ""}`) || !!t.channel;

const KINDS = ["follow_up", "first_email", "late"] as const;
export async function nextWork(actor: Actor, o: { limit?: number; assignee?: number | "all"; action?: string | null; kind?: string | null } = {}) {
  if (o.kind && !(KINDS as readonly string[]).includes(o.kind)) throw new HttpError(400, `kind: one of ${KINDS.join(", ")}.`);
  const viewAll = can(actor, "tasks.view_all") || isManager(actor);
  const team = o.assignee === "all";
  if (team && !viewAll) throw new HttpError(403, "Only the Owner or a Chief can read the whole team's work list.");
  if (!team && o.assignee && o.assignee !== actor.id && !viewAll) throw new HttpError(403, "You can only read your own work list.");
  const only = o.action ? (String(o.action).toLowerCase() as Action) : null;
  if (only && !ACTIONS.includes(only)) throw new HttpError(400, `action: one of ${ACTIONS.join(", ")}.`);
  const who = team ? null : (o.assignee as number | undefined) ?? actor.id;
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
  const today = todayYmd();
  const d2 = localMidnight(addDays(today, 2)).toISOString();
  const mine = who == null ? "" : " AND t.assignee_id=?";
  const mineArgs: InValue[] = who == null ? [] : [who];
  // Dated work (late, today, tomorrow) and undated work are read separately, so a pile of undated tasks can never crowd out dated ones.
  const cols = `t.id,t.title,t.instructions,t.status,t.task_type,t.action_type,t.channel,t.prep_status,t.blockers,t.scheduled_at,t.due_at,t.lead_id,t.assignee_id,t.campaign_id,t.change_request,
              t.message_version_id,t.sent_at,t.activity_id,t.completed_at,t.due_on,t.scheduled_on,t.hold_reason,t.rescheduled_from,
              t.enrollment_id,t.step_code,t.step_number,t.step_total,t.window_end_on,t.draft_deadline,t.labels,t.sender_id,t.thread_subject,t.is_late,t.auto_generated,
              (SELECT sd.email FROM senders sd WHERE sd.id=t.sender_id) AS step_sender_email, (SELECT sd.display_name FROM senders sd WHERE sd.id=t.sender_id) AS step_sender_name,
              COALESCE(t.scheduled_at,t.due_at) AS sort_at, c.name AS campaign, c.status AS campaign_status, u.name AS assignee_name
       FROM tasks t LEFT JOIN campaigns c ON c.id=t.campaign_id LEFT JOIN users u ON u.id=t.assignee_id
       WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled')${mine}`;
  const [dated, undated, undatedRow] = await Promise.all([
    all(`SELECT ${cols} AND COALESCE(t.scheduled_at,t.due_at)<? ORDER BY COALESCE(t.scheduled_at,t.due_at), t.id LIMIT 400`, [...mineArgs, d2]),
    all(`SELECT ${cols} AND t.scheduled_at IS NULL AND t.due_at IS NULL ORDER BY t.id LIMIT 100`, mineArgs),
    one(`SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled')${mine} AND t.scheduled_at IS NULL AND t.due_at IS NULL`, mineArgs),
  ]);
  const kindOf = (t: Row) => (t.is_late ? "late" : /^FU\d|^LinkedIn DM|^Final|^Reply FU/.test(displayType(t)) ? "follow_up" : displayType(t) === "Email 1" ? "first_email" : "other");
  const live = (await liveTasks([...dated, ...undated])).filter((t) => !o.kind || kindOf(t) === o.kind);
  const counts = { ready: 0, overdue: 0, planned: 0, blocked: 0 };
  for (const t of live) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  // By urgency: late first, then due today, then tomorrow, then work with no date. Inside a group: earliest first.
  const urgencyOf = (t: Row): Urgency => (!t.sort_at ? "undated" : t.is_overdue ? "overdue" : toLocalInput(t.sort_at as string).slice(0, 10) <= today ? "today" : "tomorrow");
  const by_urgency = { overdue: 0, today: 0, tomorrow: 0, undated: 0 };
  const sorted = live.map((t) => ({ t, urgency: urgencyOf(t) }));
  for (const x of sorted) by_urgency[x.urgency]++;
  sorted.sort((a, b) => URGENCY[a.urgency] - URGENCY[b.urgency] || (a.t.sort_at === b.t.sort_at ? (a.t.id as number) - (b.t.id as number) : (a.t.sort_at ?? "") < (b.t.sort_at ?? "") ? -1 : 1));
  // Only a task with a draft can be a send, so an action=send search skips the rest before the (costlier) eligibility checks.
  const pool = only === "send" ? sorted.filter((x) => x.t.message_version_id && !["changes_requested", "waiting_approval"].includes(x.t.status as string)) : sorted;

  const build = async (chunk: typeof sorted) => {
    const leadIds = [...new Set(chunk.map((x) => x.t.lead_id as number | null).filter((x): x is number => !!x))];
    const inList = leadIds.map(() => "?").join(",");
    const [leads, contacts] = await Promise.all([
      leadIds.length ? all(`SELECT id,company,website,country,language,stage,historical_only FROM leads WHERE id IN (${inList})`, leadIds) : Promise.resolve([] as Row[]),
      leadIds.length ? all(`SELECT id,lead_id,name,role,email,language,email_status,is_invalid,is_primary FROM contacts WHERE lead_id IN (${inList}) ORDER BY is_primary DESC, id`, leadIds) : Promise.resolve([] as Row[]),
    ]);
    const leadOf = new Map(leads.map((l) => [l.id as number, l]));
    return Promise.all(chunk.map(async ({ t, urgency }) => {
      const vid = t.message_version_id as number | null;
      const [v, el] = vid ? await Promise.all([getVersion(actor, vid), checkEligibility(actor, vid)]) : [null, null];
      const lead = t.lead_id ? leadOf.get(t.lead_id as number) ?? null : null;
      const people = contacts.filter((c) => c.lead_id === t.lead_id).map((c) => ({ id: c.id, name: c.name, role: c.role, email: c.email, language: c.language, is_primary: !!c.is_primary,
        status: c.email_status === "opted_out" ? "opted_out" : c.email_status === "bounced" ? "bounced" : c.is_invalid ? "invalid" : "active" }));
      let action: Action, step: string;
      if (t.status === "changes_requested") {
        action = "fix";
        step = `Changes were requested: ${t.change_request ?? "see the task"}. Fix the work and submit it again (POST /tasks/${t.id}/submit).`;
      } else if (t.status === "waiting_approval") {
        action = "wait";
        step = "Submitted and waiting for a decision. Nothing to do until it is decided (watch GET /changes).";
      } else if (v && el?.eligible) {
        action = "send";
        step = `Send message version ${v.id} exactly as written, from ${v.sender?.email ?? "its sender"}, in the browser. Then POST /sends {event_id, message_version_id: ${v.id}, sent_at, evidence}. The task closes by itself.`;
      } else if (v) {
        action = "wait";
        step = `Do not send. ${el!.reasons.join("; ")}.`;
      } else if (t.state === "blocked") {
        action = "wait";
        step = `Blocked: ${t.reason ?? "see blockers"}.`;
      } else if (isOutreach(t) && t.lead_id) {
        action = "draft";
        step = `Write the draft: POST /message-versions {lead_id: ${t.lead_id}, contact_id, channel: "${t.channel ?? "email"}", campaign_id: ${t.campaign_id ?? "<campaign>"}, task_id: ${t.id}, subject, body}. It then waits for the Chief's review and the Owner's send approval.`;
      } else {
        action = "work";
        step = t.lead_id
          ? `Do the task, record what you did (POST /leads/${t.lead_id}/activities), then close it: POST /tasks/${t.id}/complete {activity_id, note}.`
          : `Do the task, then close it: POST /tasks/${t.id}/complete {note}.`;
      }
      // The note on a task is written by a person or agent when the task is made, and the CRM never rewrites it. Say so where it could be read as contradicting the live answer.
      const stale = action === "send" && t.instructions
        ? "task.instructions is the note written when this task was created or moved. If it says not to send, it is out of date: the approvals and the eligibility check were read now, and they allow this send."
        : null;
      return {
        task: { id: t.id, title: t.title, instructions: t.instructions, status: t.status, state: t.state, urgency, reason: t.reason, task_type: t.task_type, action_type: t.action_type, channel: t.channel,
          scheduled_at: t.scheduled_at, due_at: t.due_at, date_only: t.date_only, on: t.on, held: t.held, hold_reason: t.hold_reason, moved_from: t.rescheduled_from ?? t.rescheduled_from_on ?? null, moved_reason: t.moved_reason,
          prep_status: t.prep_status, blockers: t.blockers ?? null, assignee: { id: t.assignee_id, name: t.assignee_name },
          type: displayType(t), kind: kindOf(t),
          // Set on tasks a follow-up sequence planned: which step this is, the thread it answers, its window and its drafting deadline.
          sequence: t.enrollment_id ? { step_code: t.step_code, step_number: t.step_number, step_total: t.step_total, due_on: t.due_on, window_end_on: t.window_end_on, draft_deadline: t.draft_deadline, late: !!t.is_late,
            thread_subject: t.thread_subject, sender: t.sender_id ? { id: t.sender_id, email: t.step_sender_email, display_name: t.step_sender_name } : null, experiment_labels: parseLabels(t.labels) } : null },
        next_step: { action, instruction: step, ...(stale ? { note: stale } : {}) },
        lead: lead ? { id: lead.id, company: lead.company, website: lead.website, country: lead.country, language: lead.language, stage: lead.stage, historical_only: !!lead.historical_only } : null,
        contacts: people,
        campaign: t.campaign_id ? { id: t.campaign_id, name: t.campaign, status: t.campaign_status } : null,
        message_version: v ? { id: v.id, version: v.version, is_latest: v.is_latest, channel: v.channel, contact_id: v.contact_id, subject: v.subject, body: v.body, language: v.language, sender: v.sender,
          authorizations: v.authorizations.map((a) => ({ kind: a.kind, status: a.status, permitted_action: a.permitted_action, approver: a.approver_name, at: a.created_at })),
          decisions: v.decisions.map((d) => ({ kind: d.kind, reason: d.reason, new_version_id: d.new_version_id, by: d.decided_by, at: d.created_at })) } : null,
        eligibility: el ? { eligible: el.eligible, reasons: el.reasons, codes: el.codes, warnings: el.warnings } : null,
      };
    }));
  };

  // Without a filter one pass is enough. With one, keep reading down the list (in urgency order) until the page is full.
  const items: Awaited<ReturnType<typeof build>> = [];
  let scanned = 0;
  while (items.length < limit && scanned < pool.length) {
    const chunk = pool.slice(scanned, scanned + (only ? 25 : limit));
    scanned += chunk.length;
    for (const it of await build(chunk)) if ((!only || it.next_step.action === only) && items.length < limit) items.push(it);
    if (!only) break;
  }
  return {
    now: now(), timezone: TZ(), guide_version: GUIDE_VERSION, assignee_id: who, assignee: team ? "all" : who, action: only, kind: o.kind ?? null, limit,
    counts, by_urgency, undated_open_tasks: Number(undatedRow!.n), total_open: live.length, returned: items.length,
    has_more: only ? scanned < pool.length : pool.length > items.length,
    scope: `${team ? "Every assignee's" : "Your"} open tasks that are late, due today or tomorrow, or have no date${only ? `, where the next step is "${only}"` : ""}. Work planned further ahead is not listed yet.`,
    order: "By urgency: overdue, then due today, then due tomorrow, then no date. Earliest first inside each group.",
    rules: "Work top to bottom. action 'send' is the only one that allows contacting anyone, and only that exact version. 'wait' and 'fix' mean do not contact. Never work around a blocker. next_step and eligibility are computed now; they win over the older free-text note in task.instructions.",
    items,
  };
}

/* ---------- changes since ---------- */
type Change = { type: string; at: string; lead_id: number | null; task_id: number | null; message_version_id: number | null; summary: string; detail?: Record<string, unknown> };

export async function changesSince(actor: Actor, o: { since?: string | null; limit?: number } = {}) {
  let since: string;
  if (o.since) {
    const d = new Date(o.since);
    if (isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(o.since)) throw new HttpError(400, "since: an ISO timestamp with Z or an offset, e.g. 2026-11-11T08:00:00Z. Pass the next_since you got last time.");
    since = d.toISOString();
  } else since = new Date(Date.now() - 86400000).toISOString();
  const until = now();
  const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
  const mgr = isManager(actor);
  const s = leadScope(actor);
  // Drafts are "mine" when I wrote them; managers see every draft.
  const mine = mgr ? "" : " AND v.created_by=?";
  const mineArgs: InValue[] = mgr ? [] : [actor.id];
  const seeAll = mgr || actor.perms.has("compliance.view");
  if (seeAll) { await ensureReplyFollowUps(); try { await syncShortfalls(); } catch (e) { console.error("shortfall sync failed", e); } }
  const [seqEvents, stepDue, shortfalls, decisions, auths, approvals, inbound, tasks] = await Promise.all([
    // What the follow-up sequences did. Managers and the compliance monitor see all of it; everyone else sees what concerns their own tasks.
    all(`SELECT a.action,a.entity,a.entity_id,a.detail,a.created_at AS at,a.actor_name FROM audit_log a
         WHERE a.created_at>? AND a.created_at<=? AND a.action IN ('sequence_task_created','sequence_paused','sequence_resumed','sequence_stopped','sequence_completed','reply_reclassified','sequence_settings_changed','sequence_enrolled')
         ${seeAll ? "" : "AND a.action='sequence_task_created' AND a.detail LIKE ?"} ORDER BY a.id LIMIT ?`, [since, until, ...(seeAll ? [] : [`%"assignee_id":${actor.id}%`]), limit]),
    all(`SELECT t.id,t.title,t.lead_id,t.step_code,t.due_on,t.due_at,t.window_end_on,t.assignee_id FROM tasks t
         WHERE t.is_demo=0 AND t.enrollment_id IS NOT NULL AND t.status NOT IN ('completed','cancelled') AND t.due_on IS NOT NULL ${seeAll ? "" : "AND t.assignee_id=?"} AND t.due_at>? LIMIT 2000`, [...(seeAll ? [] : [actor.id]), new Date(new Date(since).getTime() - 2 * 86400000).toISOString()]),
    seeAll ? all("SELECT * FROM plan_shortfalls WHERE (first_seen>? AND first_seen<=?) OR (resolved_at>? AND resolved_at<=?) ORDER BY id LIMIT ?", [since, until, since, until, limit]) : Promise.resolve([] as Row[]),
    all(`SELECT d.kind,d.reason,d.new_version_id,d.created_at AS at,v.id AS vid,v.lead_id,v.task_id,l.company,u.name AS by_name
         FROM message_decisions d JOIN message_versions v ON v.id=d.message_version_id JOIN leads l ON l.id=v.lead_id JOIN users u ON u.id=d.decided_by
         WHERE d.created_at>? AND d.created_at<=?${mine} ORDER BY d.created_at LIMIT ?`, [since, until, ...mineArgs, limit]),
    all(`SELECT a.kind,a.status,a.permitted_action,a.created_at AS at,v.id AS vid,v.lead_id,v.task_id,l.company,u.name AS by_name
         FROM send_authorizations a JOIN message_versions v ON v.id=a.message_version_id JOIN leads l ON l.id=v.lead_id JOIN users u ON u.id=a.approver_id
         WHERE a.created_at>? AND a.created_at<=?${mine} ORDER BY a.created_at LIMIT ?`, [since, until, ...mineArgs, limit]),
    all(`SELECT a.id,a.status,a.comment,a.decided_at AS at,a.task_id,a.lead_id,a.title,u.name AS by_name FROM approvals a LEFT JOIN users u ON u.id=a.decided_by
         WHERE a.is_demo=0 AND a.decided_at>? AND a.decided_at<=?${mgr ? "" : " AND a.submitted_by=?"} ORDER BY a.decided_at LIMIT ?`, [since, until, ...(mgr ? [] : [actor.id]), limit]),
    // Replies and bounces are placed by when they were RECORDED (created_at), so a late entry is never missed.
    all(`SELECT a.id,a.type,a.outcome,a.classification,a.title,a.created_at AS at,a.occurred_at,a.lead_id,l.company FROM activities a JOIN leads l ON l.id=a.lead_id
         WHERE a.is_demo=0 AND a.created_at>? AND a.created_at<=? AND (a.type='reply' OR (a.type='outcome' AND a.outcome IN ('bounced','opted_out'))) AND ${s.sql} ORDER BY a.created_at LIMIT ?`, [since, until, ...s.args, limit]),
    all(`SELECT t.id,t.title,t.status,t.lead_id,t.created_at,t.updated_at AS at,t.hold_reason,t.change_request,COALESCE(t.scheduled_at,t.due_at) AS slot FROM tasks t
         WHERE t.is_demo=0 AND t.assignee_id=? AND t.updated_at>? AND t.updated_at<=? ORDER BY t.updated_at LIMIT ?`, [actor.id, since, until, limit]),
  ]);
  const out: Change[] = [];
  for (const e of seqEvents) {
    let det: Record<string, unknown> = {};
    try { det = e.detail ? (JSON.parse(String(e.detail)) as Record<string, unknown>) : {}; } catch { det = {}; }
    const leadId = e.entity === "lead" ? Number(e.entity_id) : (det.lead_id as number) ?? null;
    const taskId = e.entity === "task" ? Number(e.entity_id) : null;
    const text: Record<string, string> = {
      sequence_task_created: `The follow-up sequence planned ${det.step ?? "a step"}${det.due_on ? `, due ${det.due_on}` : ""}${det.late ? " (LATE)" : ""}. It needs a draft.`,
      sequence_enrolled: "The lead entered a follow-up sequence.", sequence_paused: `Sequence paused: ${det.reason ?? ""}`.trim(), sequence_resumed: "Sequence resumed.",
      sequence_stopped: `Sequence stopped: ${det.reason ?? "no reason given"}. Pending follow-ups were cancelled; do not send them.`,
      sequence_completed: det.rest_until ? `Sequence finished; the lead rests until ${det.rest_until}.` : "Sequence finished.",
      reply_reclassified: `${e.actor_name} changed a reply from ${det.from} to ${det.to}: ${det.reason ?? ""}`.trim(), sequence_settings_changed: `${e.actor_name} changed the follow-up settings.`,
    };
    out.push({ type: e.action as string, at: e.at as string, lead_id: leadId, task_id: taskId, message_version_id: null, summary: text[e.action as string] ?? String(e.action), detail: det });
  }
  // A step becomes due at the start of its due day and overdue at the end of it (Asia/Hebron).
  for (const t of stepDue) {
    const start = localMidnight(t.due_on as string).toISOString();
    if (start > since && start <= until) out.push({ type: "sequence_step_due", at: start, lead_id: t.lead_id, task_id: t.id, message_version_id: null, summary: `${t.title} is due today${t.window_end_on ? ` (window to ${t.window_end_on})` : ""}.`, detail: { step: t.step_code, due_on: t.due_on, window_end_on: t.window_end_on } });
    if ((t.due_at as string) > since && (t.due_at as string) <= until) out.push({ type: "sequence_step_overdue", at: t.due_at as string, lead_id: t.lead_id, task_id: t.id, message_version_id: null, summary: `${t.title} was due ${t.due_on} and is not sent.`, detail: { step: t.step_code, due_on: t.due_on, window_end_on: t.window_end_on } });
  }
  for (const s of shortfalls) {
    if ((s.first_seen as string) > since) out.push({ type: "work_plan_shortfall", at: s.first_seen as string, lead_id: null, task_id: null, message_version_id: null, summary: s.message as string, detail: { plan_date: s.plan_date, role: s.role, sender_id: s.sender_id || null, kind: s.kind, gap: s.gap, status: "open" } });
    if (s.resolved_at && (s.resolved_at as string) > since) out.push({ type: "work_plan_shortfall_resolved", at: s.resolved_at as string, lead_id: null, task_id: null, message_version_id: null, summary: `Closed: ${s.message}`, detail: { plan_date: s.plan_date, role: s.role, sender_id: s.sender_id || null, kind: s.kind, status: "resolved" } });
  }
  for (const d of decisions) out.push({ type: d.kind === "rejected" ? "draft_rejected" : "draft_edited", at: d.at, lead_id: d.lead_id, task_id: d.task_id ?? null, message_version_id: d.vid,
    summary: d.kind === "rejected" ? `${d.by_name} rejected the draft for ${d.company}: ${d.reason ?? "no reason given"}. Prepare a new, different version.` : `${d.by_name} edited the draft for ${d.company}; the new text is version ${d.new_version_id}. Use that one.`,
    detail: { reason: d.reason, new_version_id: d.new_version_id } });
  for (const a of auths) out.push({ type: a.kind === "send" ? "send_approved" : "editorial_approved", at: a.at, lead_id: a.lead_id, task_id: a.task_id ?? null, message_version_id: a.vid,
    summary: a.kind === "send" ? `${a.by_name} approved sending version ${a.vid} to ${a.company} (${a.permitted_action}). Check eligibility, then send.` : `${a.by_name} reviewed version ${a.vid} for ${a.company}. It still needs the Owner's send approval.`,
    detail: { status: a.status, permitted_action: a.permitted_action } });
  for (const a of approvals) out.push({ type: `approval_${a.status}`, at: a.at, lead_id: a.lead_id ?? null, task_id: a.task_id, message_version_id: null,
    summary: `${a.by_name ?? "A manager"} marked "${a.title}" as ${String(a.status).replace(/_/g, " ")}${a.comment ? `: ${a.comment}` : ""}.`, detail: { approval_id: a.id, comment: a.comment } });
  for (const a of inbound) out.push({ type: a.type === "reply" ? "reply_received" : a.outcome === "bounced" ? "bounce" : "opt_out", at: a.at, lead_id: a.lead_id, task_id: null, message_version_id: null,
    summary: a.type === "reply" ? `Reply from ${a.company}${a.classification ? ` (${String(a.classification).replace(/_/g, " ")})` : ""}: ${a.title ?? ""}`.trim() : a.outcome === "bounced" ? `A message to ${a.company} bounced. Do not contact that address again.` : `${a.company} opted out. Never contact again.`,
    detail: { activity_id: a.id, occurred_at: a.occurred_at, classification: a.classification } });
  for (const t of tasks) out.push({ type: t.created_at > since ? "task_assigned" : `task_${t.status}`, at: t.at, lead_id: t.lead_id ?? null, task_id: t.id, message_version_id: null,
    summary: t.created_at > since ? `New task for you: ${t.title}.` : `Your task "${t.title}" is now ${String(t.status).replace(/_/g, " ")}${t.status === "changes_requested" && t.change_request ? `: ${t.change_request}` : t.hold_reason && t.slot && toLocalInput(t.slot).slice(0, 10) > todayYmd() ? ` (held: ${t.hold_reason})` : ""}.` });
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const truncated = out.length > limit;
  const changes = out.slice(0, limit);
  return {
    since, next_since: truncated ? changes[changes.length - 1].at : until, has_more: truncated, count: changes.length,
    note: "Pass next_since as ?since= on your next call. Changes are ordered oldest first. Replies and bounces appear by the time they were recorded.",
    changes,
  };
}
