import { z } from "zod";
import type { InValue } from "@libsql/client";
import { all, one, run, now, tx, type Row } from "../db";
import { HttpError, can, requirePerm, isManager, type Actor } from "../auth";
import { OPEN_TASK_STATUSES, TASK_STATUSES, type TaskStatus } from "../constants";
import { audit, parse, optText, optInt, optDate, optBool, reqText, assertListKey } from "./common";
import { assertLeadAccess } from "./leads";
import { assertChannel, PREP_STATUSES } from "./campaigns";
import { parseWhen } from "./common";
import { liveTasks, dateOnlyOf, type LiveTask } from "./taskview";

/* ================= tasks ================= */

async function defaultApprover(taskType: string | null): Promise<"chief" | "wisam"> {
  if (!taskType) return "chief";
  const r = await one("SELECT flag FROM lists WHERE kind='task_type' AND key=?", [taskType]);
  return r?.flag === "wisam" ? "wisam" : "chief";
}

const createSchema = z.object({
  title: reqText(200),
  instructions: optText(8000),
  lead_id: optInt,
  assignee_id: optInt,
  task_type: optText(60),
  due_at: optDate,
  approval: z.enum(["default", "chief", "wisam", "none"]).optional(),
  scheduled_at: z.unknown().optional(),
  channel: optText(30).optional(),
  action_type: optText(60).optional(),
  prep_status: z.preprocess((v) => (v === "" ? null : v), z.enum(PREP_STATUSES).nullable()).optional(),
  blockers: optText(1000).optional(),
  campaign_id: optInt.optional(),
  is_test: optBool.optional(),
});

/** scheduled_at accepts the same timestamp formats as event dates (explicit Z/offset preferred); the raw input is kept. */
function schedule(v: unknown): { at: string | null; input: string | null } {
  if (v == null || v === "") return { at: null, input: null };
  if (typeof v !== "string") throw new HttpError(400, "scheduled_at: send an ISO timestamp such as 2026-11-09T10:00:00+02:00 (or Z), or null.");
  const at = parseWhen(v);
  if (!at || at === "invalid") throw new HttpError(400, `scheduled_at: "${v}" is not a valid date/time. Use YYYY-MM-DDTHH:mm[:ss] with Z or an offset.`);
  return { at, input: v.trim() };
}
async function assertCampaign(id: number | null | undefined) {
  if (id && !(await one("SELECT id FROM campaigns WHERE id=?", [id]))) throw new HttpError(400, "campaign_id: unknown campaign.");
}

export async function createTask(actor: Actor, input: unknown, isDemo = false) {
  const d = parse(createSchema, input);
  const assignee = d.assignee_id ?? actor.id;
  if (assignee !== actor.id) requirePerm(actor, "tasks.assign");
  else if (!can(actor, "tasks.create_own") && !can(actor, "tasks.assign")) requirePerm(actor, "tasks.create_own");
  if (!isDemo && !(await one("SELECT id FROM users WHERE id=? AND active=1", [assignee]))) throw new HttpError(400, "assignee_id: unknown or disabled employee.");
  let leadRow: Row | null = null;
  if (d.lead_id) leadRow = await assertLeadAccess(actor, d.lead_id);
  if (leadRow?.historical_only) throw new HttpError(400, "lead_id: that lead is historical-only (kept for past replies / suppression) and is not an outreach prospect, so no work can be assigned on it.");
  await assertListKey("task_type", d.task_type, "task_type");
  if (d.is_test && leadRow && !leadRow.is_demo) throw new HttpError(400, "is_test: a task on a real lead is real work. Mark the lead as test data instead.");
  const isTest = isDemo || !!d.is_test || !!leadRow?.is_demo;

  await assertChannel(d.channel);
  await assertCampaign(d.campaign_id);
  const sch = schedule(d.scheduled_at);
  const base = await defaultApprover(d.task_type);
  const choice = d.approval ?? "default";
  let approvalFrom: "chief" | "wisam" | null;
  if (choice === "none") {
    requirePerm(actor, "tasks.assign");
    approvalFrom = null;
  } else if (choice === "wisam") approvalFrom = "wisam";
  else if (choice === "chief") approvalFrom = base === "wisam" && actor.role !== "owner" ? "wisam" : "chief";
  else approvalFrom = base;

  const t = now();
  const r = await run(
    `INSERT INTO tasks (lead_id,assignee_id,created_by,title,instructions,task_type,approval_from,due_at,is_demo,created_at,updated_at,scheduled_at,scheduled_input,channel,action_type,prep_status,blockers,campaign_id,due_on,scheduled_on)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.lead_id, assignee, actor.id, d.title, d.instructions, d.task_type, approvalFrom, d.due_at, isTest ? 1 : 0, t, t, sch.at, sch.input, d.channel ?? null, d.action_type ?? null, d.prep_status ?? null, d.blockers ?? null, d.campaign_id ?? null, dateOnlyOf(d.due_at), dateOnlyOf(sch.at)],
  );
  if (d.lead_id)
    await run(
      `INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.lead_id, r.id, "task", assignee === actor.id ? `Task created: ${d.title}` : `Task assigned: ${d.title}`, d.instructions, actor.id, t, t, leadRow?.is_demo ?? 0],
    );
  await audit(actor, "create_task", "task", r.id, { assignee, lead_id: d.lead_id, approval_from: approvalFrom });
  return r.id;
}

export type TaskFilters = {
  assignee?: number; status?: string; lead?: number; overdue?: boolean; open?: boolean; includeDemo?: boolean; limit?: number; q?: string; page?: number; pageSize?: number;
};
export async function listTasks(actor: Actor, f: TaskFilters = {}): Promise<LiveTask[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  const viewAll = can(actor, "tasks.view_all") || isManager(actor);
  const assignee = viewAll ? f.assignee : actor.id;
  if (assignee) (where.push("t.assignee_id=?"), args.push(assignee));
  if (f.status && (TASK_STATUSES as readonly string[]).includes(f.status)) (where.push("t.status=?"), args.push(f.status));
  if (f.lead) (where.push("t.lead_id=?"), args.push(f.lead));
  if (f.open) where.push(`t.status IN (${OPEN_TASK_STATUSES.map(() => "?").join(",")})`), args.push(...OPEN_TASK_STATUSES);
  if (f.overdue) (where.push(`t.due_at < ? AND t.status IN ('todo','in_progress','changes_requested','approved')`), args.push(now()));
  if (!f.includeDemo) where.push("t.is_demo=0");
  if (f.q?.trim()) { const like = `%${f.q.trim().toLowerCase()}%`; where.push("(lower(t.title) LIKE ? OR lower(l.company) LIKE ?)"); args.push(like, like); }
  const size = Math.min(Math.max(f.pageSize ?? f.limit ?? 300, 1), 300);
  const offset = f.page && f.page > 1 ? (f.page - 1) * size : 0;
  return liveTasks(await all(
    `SELECT t.*, l.company, u.name AS assignee_name, cb.name AS created_by_name, cu.name AS completed_by_name,
            (SELECT a.id FROM approvals a WHERE a.task_id=t.id AND a.status='pending' ORDER BY a.id DESC LIMIT 1) AS pending_approval_id,
            (SELECT COUNT(*) FROM task_notes n WHERE n.task_id=t.id) AS note_count
     FROM tasks t
     JOIN users u ON u.id=t.assignee_id JOIN users cb ON cb.id=t.created_by LEFT JOIN users cu ON cu.id=t.completed_by LEFT JOIN leads l ON l.id=t.lead_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (t.due_at IS NULL), t.due_at ASC, t.id DESC LIMIT ? OFFSET ?`,
    [...args, size, offset],
  ));
}

/** Server-side paging for long lists: 50 per page by default; has_more tells whether there is a next page. */
export async function listTasksPaged(actor: Actor, f: TaskFilters = {}) {
  const size = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const rows = await listTasks(actor, { ...f, page, pageSize: size });
  return { rows, page, page_size: size, has_more: rows.length === size };
}

export async function getTask(actor: Actor, id: number): Promise<Row> {
  const t = await one(
    `SELECT t.*, l.company, u.name AS assignee_name, cb.name AS created_by_name, cu.name AS completed_by_name FROM tasks t
     JOIN users u ON u.id=t.assignee_id JOIN users cb ON cb.id=t.created_by LEFT JOIN users cu ON cu.id=t.completed_by LEFT JOIN leads l ON l.id=t.lead_id WHERE t.id=?`,
    [id],
  );
  if (!t || (t.assignee_id !== actor.id && !can(actor, "tasks.view_all") && !isManager(actor))) throw new HttpError(404, "Task not found.");
  return (await liveTasks([t]))[0];
}

/** One task with its full note history, approvals and a single chronological timeline (who did what, when). */
export type TaskEvent = { at: string; event: string; actor: string | null; text: string | null; approval_id?: number };
export type TaskDetail = Row & { notes: Row[]; approvals: Row[]; timeline: TaskEvent[]; activity?: Row | null };
export async function getTaskDetail(actor: Actor, id: number): Promise<TaskDetail> {
  const task = await getTask(actor, id);
  const notes = await all(
    `SELECT n.id, n.kind, n.body, n.created_at, n.actor_id, u.name AS actor_name FROM task_notes n LEFT JOIN users u ON u.id=n.actor_id WHERE n.task_id=? ORDER BY n.id`,
    [id],
  );
  const approvals = await all(
    `SELECT a.id, a.kind, a.title, a.content, a.requires, a.status, a.comment,
            a.submitted_by, s.name AS submitted_by_name, a.created_at AS submitted_at,
            a.decided_by, d.name AS decided_by_name, a.decided_at
     FROM approvals a JOIN users s ON s.id=a.submitted_by LEFT JOIN users d ON d.id=a.decided_by WHERE a.task_id=? ORDER BY a.id`,
    [id],
  );
  let activity: Row | null = null;
  if (task.activity_id) {
    activity = await one(
      `SELECT a.id, a.type, a.title, a.body, a.occurred_at, a.created_at, a.channel, a.message_kind, a.outcome, u.name AS actor_name
       FROM activities a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id=?`,
      [task.activity_id],
    );
  }
  const timeline: TaskEvent[] = [{ at: task.created_at, event: "task_created", actor: task.created_by_name, text: task.assignee_id === task.created_by ? "Task created" : `Assigned to ${task.assignee_name}` }];
  for (const n of notes) if (n.kind !== "completion") timeline.push({ at: n.created_at, event: n.kind === "completion" ? "completion_note" : "progress_note", actor: n.actor_name, text: n.body });
  for (const a of approvals) {
    timeline.push({ at: a.submitted_at, event: "submitted", actor: a.submitted_by_name, text: `${a.kind}: ${a.title}`, approval_id: a.id });
    if (a.decided_at) timeline.push({ at: a.decided_at, event: a.status, actor: a.decided_by_name, text: a.comment, approval_id: a.id });
  }
  if (task.completed_at) timeline.push({ at: task.completed_at, event: "completed", actor: task.completed_by_name, text: task.completion_note });
  timeline.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return Object.assign(task, { notes, approvals, timeline, activity });
}

/** One approval, for the same people who can see it in the queue. */
export async function getApproval(actor: Actor, id: number): Promise<Row> {
  const [a] = await listApprovals(actor, { includeDemo: true, id });
  if (!a) throw new HttpError(404, "Approval not found.");
  return a;
}

const updateSchema = z.object({
  status: z.enum(["todo", "in_progress", "cancelled"]).optional(),
  progress_note: optText(4000).optional(),
  title: reqText(200).optional(),
  instructions: optText(8000).optional(),
  due_at: optDate.optional(),
  assignee_id: optInt.optional(),
  scheduled_at: z.unknown().optional(),
  channel: optText(30).optional(),
  action_type: optText(60).optional(),
  prep_status: z.preprocess((v) => (v === "" ? null : v), z.enum(PREP_STATUSES).nullable()).optional(),
  blockers: optText(1000).optional(),
  campaign_id: optInt.optional(),
});

export async function updateTask(actor: Actor, id: number, input: Record<string, unknown>) {
  const t = await getTask(actor, id);
  const d = parse(updateSchema, Object.fromEntries(Object.entries(input).filter(([k]) => k in updateSchema.shape)));
  const isAssignee = t.assignee_id === actor.id;
  const canManage = can(actor, "tasks.assign");
  const isCreator = t.created_by === actor.id;
  if (!isAssignee && !canManage) throw new HttpError(403, "This task is not assigned to you.");
  if (["completed", "cancelled"].includes(t.status)) throw new HttpError(400, `Task is already ${t.status}.`);

  const sets: string[] = [];
  const args: InValue[] = [];
  const changes: Record<string, unknown> = {};
  const set = (k: string, v: InValue) => {
    if (v !== t[k]) (sets.push(`${k}=?`), args.push(v), (changes[k] = { from: t[k], to: v }));
  };

  if (d.progress_note !== undefined) set("progress_note", d.progress_note);
  if (d.status) {
    if (d.status === "cancelled") {
      if (!canManage && !isCreator) throw new HttpError(403, "Only the person who assigned a task (or a manager) can cancel it.");
      set("status", "cancelled");
    } else {
      if (!["todo", "in_progress", "changes_requested"].includes(t.status))
        throw new HttpError(400, `A task that is "${t.status}" can't be moved to ${d.status} by hand.`);
      set("status", d.status);
    }
  }
  if (d.title !== undefined || d.instructions !== undefined || d.due_at !== undefined || d.assignee_id !== undefined) {
    if (!canManage && !(isCreator && isAssignee)) throw new HttpError(403, "Only a manager can change the task's details, due date or assignee.");
    if (d.title !== undefined) set("title", d.title);
    if (d.instructions !== undefined) set("instructions", d.instructions);
    if (d.due_at !== undefined) { set("due_at", d.due_at); set("due_on", dateOnlyOf(d.due_at)); }
    if (d.assignee_id !== undefined && d.assignee_id !== null) {
      if (!canManage) throw new HttpError(403, "Only a manager can reassign tasks.");
      if (!(await one("SELECT id FROM users WHERE id=? AND active=1", [d.assignee_id]))) throw new HttpError(400, "assignee_id: unknown or disabled employee.");
      set("assignee_id", d.assignee_id);
    }
  }
  // Structured planning fields: the assignee may keep their own preparation status and blockers current;
  // scheduling, channel, campaign and action type are manager/creator edits like the due date.
  const prep = d.prep_status !== undefined || d.blockers !== undefined;
  const plan = d.scheduled_at !== undefined || d.channel !== undefined || d.action_type !== undefined || d.campaign_id !== undefined;
  if (plan && !canManage && !(isCreator && isAssignee)) throw new HttpError(403, "Only a manager can change the schedule, channel, campaign or action type.");
  if (prep) {
    if (d.prep_status !== undefined) set("prep_status", d.prep_status);
    if (d.blockers !== undefined) set("blockers", d.blockers);
  }
  if (d.channel !== undefined) { await assertChannel(d.channel); set("channel", d.channel); }
  if (d.action_type !== undefined) set("action_type", d.action_type);
  if (d.campaign_id !== undefined) { await assertCampaign(d.campaign_id); set("campaign_id", d.campaign_id); }
  if (d.scheduled_at !== undefined) { const sch = schedule(d.scheduled_at); set("scheduled_at", sch.at); set("scheduled_input", sch.input); set("scheduled_on", dateOnlyOf(sch.at)); }
  if (!sets.length) return;
  const stmts = [{ sql: `UPDATE tasks SET ${sets.join(",")}, updated_at=? WHERE id=?`, args: [...args, now(), id] as InValue[] }];
  if (d.status === "cancelled")
    stmts.push({
      sql: "UPDATE approvals SET status='rejected', decided_by=?, decided_at=?, comment='Task was cancelled' WHERE task_id=? AND status='pending'",
      args: [actor.id, now(), id],
    });
  if (d.progress_note && d.progress_note !== t.progress_note)
    stmts.push({ sql: "INSERT INTO task_notes (task_id,kind,body,actor_id,created_at) VALUES (?,?,?,?,?)", args: [id, "progress", d.progress_note, actor.id, now()] });
  await tx(stmts);
  if (t.lead_id && d.status === "cancelled")
    await run(`INSERT INTO activities (lead_id,task_id,type,title,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?)`,
      [t.lead_id, id, "task", `Task cancelled: ${t.title}`, actor.id, now(), now(), t.is_demo]);
  await audit(actor, "update_task", "task", id, changes);
}

/**
 * Owner/Chief deliberately holds a task (for example the daily send cap is reached) and moves it to the next send slot.
 * The reason is stored on the task and shown in plain words; the old time is kept; the task is no longer overdue.
 */
export async function rescheduleTask(actor: Actor, id: number, input: unknown) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or a Chief can reschedule a task.");
  const d = parse(z.object({ scheduled_at: z.string().min(8, "required: the next send slot (ISO time with offset, or YYYY-MM-DD)"), reason: z.string().trim().min(3, "reason: say why it is moved (for example: daily send limit reached)").max(500) }), input);
  const t = await getTask(actor, id);
  if (["completed", "cancelled"].includes(t.status as string)) throw new HttpError(400, `Task is already ${t.status}.`);
  const sch = schedule(d.scheduled_at);
  if (!sch.at) throw new HttpError(400, "scheduled_at: required.");
  const raw = (await one("SELECT scheduled_at,due_at FROM tasks WHERE id=?", [id]))!;
  const was = (raw.scheduled_at ?? raw.due_at ?? null) as string | null;
  if (was && sch.at <= was) throw new HttpError(400, "scheduled_at: the new slot must be later than the current one.");
  const ts = now();
  // The deadline moves with the slot when it was earlier, so reports do not keep counting a deliberate hold as overdue.
  const moveDue = !raw.due_at || (raw.due_at as string) < sch.at;
  await tx([
    { sql: `UPDATE tasks SET scheduled_at=?, scheduled_input=?, scheduled_on=?, hold_reason=?, rescheduled_from=?${moveDue ? ", due_at=?, due_on=?" : ""}, updated_at=? WHERE id=?`, args: [sch.at, sch.input, dateOnlyOf(sch.at), d.reason, was, ...(moveDue ? [sch.at, dateOnlyOf(sch.at)] : []), ts, id] as InValue[] },
    ...(t.lead_id ? [{ sql: "INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'task',?,?,?,?,?,?)", args: [t.lead_id as number, id, `Task rescheduled: ${t.title}`, `Held: ${d.reason}`, actor.id, ts, ts, t.is_demo as number] as InValue[] }] : []),
  ]);
  await audit(actor, "reschedule_task", "task", id, { from: was, to: sch.at, reason: d.reason });
  return { id, scheduled_at: dateOnlyOf(sch.at) ? null : sch.at, on: dateOnlyOf(sch.at), hold_reason: d.reason, rescheduled_from: was };
}

export type CompleteTaskInput = {
  note?: string | null;
  activity_id?: number | null;
};

/** Employee says: the work is done (outside the CRM). Tasks that need approval must be approved first. */
export async function completeTask(actor: Actor, id: number, input?: string | null | CompleteTaskInput) {
  const opts: CompleteTaskInput = typeof input === "string" || input === null || input === undefined ? { note: input ?? null } : input;
  const t = await getTask(actor, id);
  // The assignee, or an Owner/Chief closing it on their behalf (audit-logged as such).
  const byManager = t.assignee_id !== actor.id;
  if (byManager && !isManager(actor)) throw new HttpError(403, "This task is not assigned to you.");
  if (["completed", "cancelled"].includes(t.status)) throw new HttpError(400, `Task is already ${t.status}.`);
  if (!byManager && t.approval_from && t.status !== "approved")
    throw new HttpError(400, t.status === "waiting_approval" ? `Waiting for ${t.approval_from === "wisam" ? "Wisam" : "Chief"} to approve.` : "This task needs approval first — submit it for approval.");

  let activityRow: Row | null = null;
  if (opts.activity_id !== undefined && opts.activity_id !== null) {
    const actIdNum = Number(opts.activity_id);
    if (!Number.isInteger(actIdNum) || actIdNum < 1) {
      throw new HttpError(400, "activity_id: must be a positive integer.");
    }
    activityRow = await one("SELECT * FROM activities WHERE id=?", [actIdNum]);
    if (!activityRow) throw new HttpError(400, "activity_id: activity not found.");
    if (!t.lead_id || activityRow.lead_id !== t.lead_id) {
      throw new HttpError(400, "activity_id: that activity does not belong to the same lead as the task.");
    }
  }

  const ts = now();
  const cn = opts.note?.trim() || null;
  const actId = activityRow ? Number(activityRow.id) : null;
  // The completion note is stored on its own: earlier progress notes are never overwritten.
  const stmts: { sql: string; args: InValue[] }[] = [
    { sql: "UPDATE tasks SET status='completed', completed_at=?, completed_by=?, completion_note=?, activity_id=?, sent_at=COALESCE(?,sent_at), updated_at=? WHERE id=?", args: [ts, actor.id, cn, actId, activityRow && activityRow.type === "message" && activityRow.outcome === "sent" && activityRow.occurred_precision === "time" ? (activityRow.occurred_at as string) : null, ts, id] },
  ];
  if (cn) stmts.push({ sql: "INSERT INTO task_notes (task_id,kind,body,actor_id,created_at) VALUES (?,?,?,?,?)", args: [id, "completion", cn, actor.id, ts] });
  if (actId) {
    stmts.push({ sql: "UPDATE activities SET task_id=? WHERE id=?", args: [id, actId] });
  }
  await tx(stmts);
  if (t.lead_id)
    await run(`INSERT INTO activities (lead_id,task_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?)`,
      [t.lead_id, id, "task", `Task completed: ${t.title}`, cn, actor.id, ts, ts, t.is_demo]);
  await audit(actor, "complete_task", "task", id, { activity_id: actId, note: cn, ...(byManager ? { by_manager: true, assignee_id: t.assignee_id } : {}) });
}

/* ================= approvals ================= */

const submitSchema = z.object({
  kind: z.enum(["draft", "findings", "other"]),
  title: optText(200),
  content: z.string().trim().min(3, "describe the draft or findings you are submitting").max(30000),
});

export async function submitTask(actor: Actor, taskId: number, input: unknown) {
  requirePerm(actor, "approvals.submit");
  const t = await getTask(actor, taskId);
  if (t.assignee_id !== actor.id) throw new HttpError(403, "Only the assignee can submit this task.");
  if (!["todo", "in_progress", "changes_requested"].includes(t.status)) throw new HttpError(400, `Can't submit a task that is "${t.status}".`);
  if (!t.approval_from) throw new HttpError(400, "This task does not need approval — record the work and mark it complete.");
  const d = parse(submitSchema, input);
  // A Chief can't approve their own work: it goes to Wisam.
  const requires = t.approval_from === "chief" && actor.role === "chief" ? "wisam" : t.approval_from;
  const ts = now();
  const title = d.title || t.title;
  const r = await run(
    `INSERT INTO approvals (task_id,lead_id,submitted_by,kind,title,content,requires,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [taskId, t.lead_id, actor.id, d.kind, title, d.content, requires, t.is_demo, ts],
  );
  await tx([
    { sql: "UPDATE tasks SET status='waiting_approval', approval_from=?, change_request=NULL, updated_at=? WHERE id=?", args: [requires, ts, taskId] },
  ]);
  if (t.lead_id) {
    if (d.kind !== "other")
      await run(`INSERT INTO activities (lead_id,task_id,approval_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [t.lead_id, taskId, r.id, d.kind === "draft" ? "draft" : "research", title, d.content, actor.id, ts, ts, t.is_demo]);
    await run(`INSERT INTO activities (lead_id,task_id,approval_id,type,title,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?)`,
      [t.lead_id, taskId, r.id, "approval", `Submitted for approval (${requires === "wisam" ? "Wisam" : "Chief"})`, actor.id, ts, ts, t.is_demo]);
  }
  await audit(actor, "submit_for_approval", "approval", r.id, { task_id: taskId, requires });
  return r.id;
}

export function canDecide(actor: Actor, ap: Row): { ok: boolean; reason?: string } {
  if (!can(actor, "approvals.decide")) return { ok: false, reason: "Your account can't decide approvals." };
  if (ap.status !== "pending") return { ok: false, reason: "Already decided." };
  if (ap.submitted_by === actor.id && actor.role !== "owner") return { ok: false, reason: "You can't approve your own submission." };
  if (ap.requires === "wisam" && actor.role !== "owner") return { ok: false, reason: "Pending Wisam — only the owner can decide this." };
  return { ok: true };
}

export async function listApprovals(actor: Actor, f: { status?: string; requires?: string; includeDemo?: boolean; id?: number } = {}): Promise<Row[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  if (!can(actor, "approvals.decide") && !isManager(actor)) (where.push("a.submitted_by=?"), args.push(actor.id));
  if (f.status) (where.push("a.status=?"), args.push(f.status));
  if (f.requires) (where.push("a.requires=?"), args.push(f.requires));
  if (f.id) (where.push("a.id=?"), args.push(f.id));
  if (!f.includeDemo) where.push("a.is_demo=0");
  return all(
    `SELECT a.*, a.created_at AS submitted_at, l.company, l.stage, t.title AS task_title, t.instructions AS task_instructions, t.task_type,
            s.name AS submitted_by_name, d.name AS decided_by_name
     FROM approvals a JOIN tasks t ON t.id=a.task_id JOIN users s ON s.id=a.submitted_by
     LEFT JOIN users d ON d.id=a.decided_by LEFT JOIN leads l ON l.id=a.lead_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (a.status='pending') DESC, a.created_at DESC LIMIT 200`,
    args,
  );
}

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "changes_requested"]),
  comment: optText(4000),
});

export async function decideApproval(actor: Actor, approvalId: number, input: unknown) {
  const d = parse(decisionSchema, input);
  const ap = await one("SELECT * FROM approvals WHERE id=?", [approvalId]);
  if (!ap) throw new HttpError(404, "Approval not found.");
  const c = canDecide(actor, ap);
  if (!c.ok) throw new HttpError(403, c.reason!);
  if (d.decision !== "approved" && !d.comment) throw new HttpError(400, "comment: explain what is wrong / what to change.");
  const ts = now();
  const taskStatus: TaskStatus = d.decision === "approved" ? "approved" : d.decision === "rejected" ? "cancelled" : "changes_requested";
  await tx([
    { sql: "UPDATE approvals SET status=?, decided_by=?, decided_at=?, comment=? WHERE id=?", args: [d.decision, actor.id, ts, d.comment, approvalId] },
    {
      sql: "UPDATE tasks SET status=?, change_request=?, completed_at=NULL, updated_at=? WHERE id=?",
      args: [taskStatus, d.decision === "changes_requested" ? d.comment : null, ts, ap.task_id],
    },
  ]);
  const label = d.decision === "approved" ? "Approved" : d.decision === "rejected" ? "Rejected" : "Changes requested";
  if (ap.lead_id)
    await run(`INSERT INTO activities (lead_id,task_id,approval_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ap.lead_id, ap.task_id, approvalId, "approval", `${label}: ${ap.title}`, d.comment, actor.id, ts, ts, ap.is_demo]);
  await audit(actor, `approval_${d.decision}`, "approval", approvalId, { task_id: ap.task_id, comment: d.comment });
}

/** Chief hands a pending item up to Wisam. */
export async function escalateApproval(actor: Actor, approvalId: number, comment: string) {
  const ap = await one("SELECT * FROM approvals WHERE id=?", [approvalId]);
  if (!ap) throw new HttpError(404, "Approval not found.");
  if (ap.status !== "pending") throw new HttpError(400, "Already decided.");
  if (ap.requires === "wisam") throw new HttpError(400, "Already waiting for Wisam.");
  if (!can(actor, "approvals.decide")) throw new HttpError(403, "Your account can't act on approvals.");
  const ts = now();
  await tx([
    { sql: "UPDATE approvals SET requires='wisam', comment=? WHERE id=?", args: [comment?.trim() || null, approvalId] },
    { sql: "UPDATE tasks SET approval_from='wisam', updated_at=? WHERE id=?", args: [ts, ap.task_id] },
  ]);
  if (ap.lead_id)
    await run(`INSERT INTO activities (lead_id,task_id,approval_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ap.lead_id, ap.task_id, approvalId, "approval", `Escalated to Wisam: ${ap.title}`, comment?.trim() || null, actor.id, ts, ts, ap.is_demo]);
  await audit(actor, "approval_escalated", "approval", approvalId, { comment });
}
