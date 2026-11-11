import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, todayYmd, TZ, now, type Row } from "../db";
import { HttpError, can, isManager, type Actor } from "../auth";
import { GUIDE_VERSION } from "../agent-guide";
import { leadScope } from "./leads";
import { liveTasks, type WorkState } from "./taskview";
import { getVersion, checkEligibility } from "./sends";

/**
 * Two calls that replace most of an agent's stitching:
 *   nextWork     - "what should I do now?": the work list with the lead, contact, draft, approvals and eligibility attached,
 *                  and for each item the one next step in plain words.
 *   changesSince - "what happened since my last run?": decisions on my drafts, new approvals, replies, bounces, task changes.
 * Both only read. They apply the same access rules as the calls they stand in for.
 */

type Action = "send" | "draft" | "work" | "wait" | "fix";
const ORDER: Record<WorkState, number> = { ready: 0, overdue: 1, planned: 2, blocked: 3, completed: 4 };
const isOutreach = (t: Row) => /send|email|follow|outreach|message|linkedin/i.test(`${t.action_type ?? ""} ${t.task_type ?? ""}`) || !!t.channel;

export async function nextWork(actor: Actor, o: { limit?: number; assignee?: number } = {}) {
  const viewAll = can(actor, "tasks.view_all") || isManager(actor);
  if (o.assignee && o.assignee !== actor.id && !viewAll) throw new HttpError(403, "You can only read your own work list.");
  const who = o.assignee ?? actor.id;
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 25);
  const today = todayYmd();
  const d2 = localMidnight(addDays(today, 2)).toISOString();
  const [rows, undatedRow] = await Promise.all([
    all(
      `SELECT t.id,t.title,t.instructions,t.status,t.task_type,t.action_type,t.channel,t.prep_status,t.blockers,t.scheduled_at,t.due_at,t.lead_id,t.assignee_id,t.campaign_id,t.change_request,
              t.message_version_id,t.sent_at,t.activity_id,t.completed_at,t.due_on,t.scheduled_on,t.hold_reason,t.rescheduled_from,
              COALESCE(t.scheduled_at,t.due_at) AS sort_at, c.name AS campaign, c.status AS campaign_status
       FROM tasks t LEFT JOIN campaigns c ON c.id=t.campaign_id
       WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') AND t.assignee_id=? AND (COALESCE(t.scheduled_at,t.due_at)<? OR (t.scheduled_at IS NULL AND t.due_at IS NULL))
       ORDER BY (COALESCE(t.scheduled_at,t.due_at) IS NULL), COALESCE(t.scheduled_at,t.due_at), t.id LIMIT 300`, [who, d2]),
    one("SELECT COUNT(*) AS n FROM tasks t WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') AND t.assignee_id=? AND t.scheduled_at IS NULL AND t.due_at IS NULL", [who]),
  ]);
  const live = await liveTasks(rows);
  const counts = { ready: 0, overdue: 0, planned: 0, blocked: 0 };
  for (const t of live) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  // Most urgent state first; inside a state by time, with tasks that have no date at all last (they are still work to do).
  const far = "9999";
  const top = [...live].sort((a, b) => ORDER[a.state] - ORDER[b.state] || ((a.sort_at ?? far) < (b.sort_at ?? far) ? -1 : 1)).slice(0, limit);

  const leadIds = [...new Set(top.map((t) => t.lead_id as number | null).filter((x): x is number => !!x))];
  const inList = leadIds.map(() => "?").join(",");
  const [leads, contacts] = await Promise.all([
    leadIds.length ? all(`SELECT id,company,website,country,language,stage,historical_only FROM leads WHERE id IN (${inList})`, leadIds) : Promise.resolve([] as Row[]),
    leadIds.length ? all(`SELECT id,lead_id,name,role,email,language,email_status,is_invalid,is_primary FROM contacts WHERE lead_id IN (${inList}) ORDER BY is_primary DESC, id`, leadIds) : Promise.resolve([] as Row[]),
  ]);
  const leadOf = new Map(leads.map((l) => [l.id as number, l]));

  const items = await Promise.all(top.map(async (t) => {
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
    return {
      task: { id: t.id, title: t.title, instructions: t.instructions, status: t.status, state: t.state, reason: t.reason, task_type: t.task_type, action_type: t.action_type, channel: t.channel,
        scheduled_at: t.scheduled_at, due_at: t.due_at, date_only: t.date_only, on: t.on, hold_reason: t.hold_reason ?? null, prep_status: t.prep_status, blockers: t.blockers ?? null },
      next_step: { action, instruction: step },
      lead: lead ? { id: lead.id, company: lead.company, website: lead.website, country: lead.country, language: lead.language, stage: lead.stage, historical_only: !!lead.historical_only } : null,
      contacts: people,
      campaign: t.campaign_id ? { id: t.campaign_id, name: t.campaign, status: t.campaign_status } : null,
      message_version: v ? { id: v.id, version: v.version, is_latest: v.is_latest, channel: v.channel, contact_id: v.contact_id, subject: v.subject, body: v.body, language: v.language, sender: v.sender,
        authorizations: v.authorizations.map((a) => ({ kind: a.kind, status: a.status, permitted_action: a.permitted_action, approver: a.approver_name, at: a.created_at })),
        decisions: v.decisions.map((d) => ({ kind: d.kind, reason: d.reason, new_version_id: d.new_version_id, by: d.decided_by, at: d.created_at })) } : null,
      eligibility: el ? { eligible: el.eligible, reasons: el.reasons, codes: el.codes, warnings: el.warnings } : null,
    };
  }));
  return {
    now: now(), timezone: TZ(), guide_version: GUIDE_VERSION, assignee_id: who,
    counts, undated_open_tasks: Number(undatedRow!.n), total_open: live.length, returned: items.length,
    scope: "Your open tasks that are late, due today or tomorrow, or have no date. Work planned further ahead is not listed yet.",
    rules: "Work top to bottom. action 'send' is the only one that allows contacting anyone, and only that exact version. 'wait' and 'fix' mean do not contact. Never work around a blocker.",
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
  const [decisions, auths, approvals, inbound, tasks] = await Promise.all([
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
    all(`SELECT t.id,t.title,t.status,t.lead_id,t.created_at,t.updated_at AS at,t.hold_reason,t.change_request FROM tasks t
         WHERE t.is_demo=0 AND t.assignee_id=? AND t.updated_at>? AND t.updated_at<=? ORDER BY t.updated_at LIMIT ?`, [actor.id, since, until, limit]),
  ]);
  const out: Change[] = [];
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
    summary: t.created_at > since ? `New task for you: ${t.title}.` : `Your task "${t.title}" is now ${String(t.status).replace(/_/g, " ")}${t.status === "changes_requested" && t.change_request ? `: ${t.change_request}` : t.hold_reason ? ` (held: ${t.hold_reason})` : ""}.` });
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const truncated = out.length > limit;
  const changes = out.slice(0, limit);
  return {
    since, next_since: truncated ? changes[changes.length - 1].at : until, has_more: truncated, count: changes.length,
    note: "Pass next_since as ?since= on your next call. Changes are ordered oldest first. Replies and bounces appear by the time they were recorded.",
    changes,
  };
}
