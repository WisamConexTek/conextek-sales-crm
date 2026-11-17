import type { InValue } from "@libsql/client";
import { all, addDays, todayYmd, type Row } from "../db";
import { HttpError, can, isManager, type Actor } from "../auth";
import { STEP_SHORT, TASK_DISPLAY_TYPES, TASK_STATUSES } from "../constants";
import { toLocalInput } from "../format";
import { parseSort, sortRows, compareValues, type SortSpec } from "../sort";
import { liveTasks, type LiveTask } from "./taskview";

/**
 * The task list as people read it: a short computed title, a short type, the live status, days overdue and a one-line blocker.
 * Nothing here is stored and no task is changed: the original title and instructions stay exactly as they were written.
 */
export const TASK_STATES = ["overdue", "blocked", "ready", "planned", "completed", "cancelled"] as const;
export const DUE_FILTERS = ["overdue", "today", "tomorrow", "this_week", "none"] as const;
export const OVERDUE_BUCKETS = ["1-2", "3-7", "8+"] as const;
export const TASK_SORTS = ["days_overdue", "due", "title", "type", "company", "campaign", "owner", "sender", "status", "updated", "created", "id"] as const;

export function displayType(t: Row): string {
  if (t.step_code && STEP_SHORT[t.step_code as string]) return STEP_SHORT[t.step_code as string];
  const a = String(t.action_type ?? "").toLowerCase(), tt = String(t.task_type ?? "").toLowerCase(), li = t.channel === "linkedin" || a.includes("linkedin");
  if (li && /connect|invite/.test(a)) return "LinkedIn connect";
  if (li) { const n = /dm_?(\d)/.exec(a)?.[1]; return n ? `LinkedIn DM${n}` : "LinkedIn DM1"; }
  if (/draft/.test(a) && /first/.test(a)) return "Email 1 draft";
  if (/draft/.test(a) && /follow/.test(a)) { const n = /follow_?up_?(\d)/.exec(a)?.[1]; return n ? `FU${n} draft` : "FU draft"; }
  if (/first_?email/.test(a)) return "Email 1";
  if (/follow/.test(a)) return `FU${/follow_?up_?(\d)/.exec(a)?.[1] ?? "1"}`;
  if (a === "handle_reply" || /reply/.test(a) || tt === "reply_draft") return "Reply";
  if (a === "revisit") return "Revisit";
  if (/^review/.test(a) || /unmatched/.test(a)) return "Review";
  if (/validate|research|referred|alternate_contact|find_contact/.test(a) || tt === "research") return "Research";
  if (tt === "first_email_draft") return "Email 1 draft";
  if (tt === "follow_up_draft") return "FU draft";
  if (tt === "pricing_offer") return "Pricing / offer";
  return "Other";
}
const firstWord = (s: unknown) => String(s ?? "").trim().split(/\s+/)[0] ?? "";
const clean = (s: string) => s.replace(/\s*[—–]\s*/g, " - ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s);
/** "{Type} · {Company} · {Sender or assignee}", about 60 characters, never an em dash. */
export function displayTitle(t: Row, type: string, senderName: string | null): string {
  const who = firstWord(senderName) && /^(Email|FU|LinkedIn|Final)/.test(type) ? firstWord(senderName) : String(t.assignee_name ?? "");
  const tail = who ? ` · ${who}` : "";
  if (!t.company) return clip(type === "Other" ? clean(String(t.title ?? "")) : `${type} · ${clean(String(t.title ?? ""))}`, 60);
  return `${type} · ${clip(clean(String(t.company)), Math.max(12, 60 - type.length - tail.length - 3))}${tail}`;
}
const localDay = (iso: unknown) => (iso ? toLocalInput(String(iso)).slice(0, 10) : null);
const diff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
/** A blocker in one short line. The full text stays on the task. */
export function blockerShort(t: Row): string | null {
  const r = String(t.reason ?? t.blocked_reason ?? t.blockers ?? "").trim();
  if (!r) return null;
  const who = /for ([A-Z][\w'-]+)/.exec(r)?.[1] ?? /^([A-Z][\w'-]+) [A-Z]?[\w'-]* ?<[^>]+>'s remaining/.exec(r)?.[1];
  if (/daily send cap reached|not started warming up/i.test(r)) return `Daily cap reached${who ? ` · ${who}` : ""}`;
  if (/pushed to the next day/i.test(r)) return "Pushed by the daily cap";
  if (/Chief's editorial review/i.test(r)) return "Waiting for the Chief's review";
  if (/Owner's send approval|no active Owner send authorization/i.test(r)) return "Waiting for the Owner's approval";
  if (/rejected/i.test(r)) return "Draft rejected, new draft needed";
  if (/opted-out/i.test(r)) return "Opted-out contact";
  if (/reply .*was recorded|reply_received/i.test(r)) return "A reply arrived";
  if (/sender .* is paused|paused \(/i.test(r)) return "Sender paused";
  if (/in no campaign/i.test(r)) return "Lead is in no campaign";
  if (/^Held:/i.test(r)) return clip(r, 80);
  if (/fit/i.test(r) && /hold|validat|chief/i.test(r)) return "Fit hold";
  return clip(r.replace(/^Approved, but not sendable:\s*/i, ""), 80);
}

export type TaskRow = LiveTask & { display_title: string; display_type: string; days_overdue: number | null; due_day: string | null; scheduled_day: string | null; urgency: string; campaign_name: string | null; sender: { id: number; display_name: string; email: string } | null; blocker_short: string | null; live_status: string; experiment_labels: string[] };
export function enrich(t: LiveTask, today: string): TaskRow {
  const done = t.status === "completed" || t.status === "cancelled";
  const dueDay = (t.due_on as string | null) ?? localDay(t.due_at);
  const schedDay = (t.scheduled_on as string | null) ?? localDay(t.scheduled_at);
  const days = !done && dueDay ? diff(today, dueDay) : null;
  const type = displayType(t);
  const day = dueDay ?? schedDay;
  const urgency = done ? "done" : !day ? "undated" : t.is_overdue || day < today ? "overdue" : day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : "later";
  let labels: string[] = [];
  try { labels = t.labels ? (JSON.parse(String(t.labels)) as string[]) : []; } catch { labels = []; }
  const sender = t.sender_ref_id ? { id: t.sender_ref_id as number, display_name: t.sender_name as string, email: t.sender_email as string } : null;
  return Object.assign(t, {
    display_type: type, display_title: displayTitle(t, type, sender?.display_name ?? null), days_overdue: days === null ? null : Math.max(days, 0) === 0 && days < 0 ? null : days, due_day: dueDay, scheduled_day: schedDay, urgency,
    campaign_name: (t.campaign_name as string | null) ?? null, sender, blocker_short: done ? null : blockerShort(t),
    live_status: t.status === "cancelled" ? "cancelled" : t.state, experiment_labels: labels,
  }) as TaskRow;
}

export type TaskListFilters = {
  assignee?: number; lead?: number; q?: string; includeTest?: boolean;
  /** open (default for the page) | all | completed | cancelled | a raw stored status */
  status?: string; state?: string; types?: string[]; campaign?: number | "none"; sender?: number | "none";
  due?: string; blocked?: boolean; overdue?: boolean; daysOverdue?: string; kind?: string;
  sort?: string; defaultSort?: string; page?: number; pageSize?: number;
};
const SORT_SPEC: SortSpec<TaskRow> = {
  days_overdue: (t) => t.days_overdue, due: (t) => t.due_day ?? null, title: (t) => t.display_title, type: (t) => t.display_type, company: (t) => (t.company as string) ?? null,
  campaign: (t) => t.campaign_name, owner: (t) => t.assignee_name as string, sender: (t) => t.sender?.display_name ?? null, status: (t) => t.live_status,
  updated: (t) => t.updated_at as string, created: (t) => t.created_at as string, id: (t) => t.id as number,
};
const SORT_ALIASES: Record<string, string> = { due_at: "due", "-due_at": "-due", due_on: "due", "-due_on": "-due", updated_at: "updated", "-updated_at": "-updated", created_at: "created", "-created_at": "-created", display_title: "title", "-display_title": "-title", assignee: "owner", "-assignee": "-owner", state: "status", "-state": "-status", oldest: "due", most_overdue: "-days_overdue" };

async function loadTasks(actor: Actor, f: TaskListFilters): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  const viewAll = can(actor, "tasks.view_all") || isManager(actor);
  const assignee = viewAll ? f.assignee : actor.id;
  if (assignee) (where.push("t.assignee_id=?"), args.push(assignee));
  if (f.lead) (where.push("t.lead_id=?"), args.push(f.lead));
  if (!f.includeTest) where.push("t.is_demo=0");
  const st = f.status ?? "all";
  if (st === "open") where.push("t.status NOT IN ('completed','cancelled')");
  else if (st !== "all" && (TASK_STATUSES as readonly string[]).includes(st)) (where.push("t.status=?"), args.push(st));
  if (f.campaign === "none") where.push("t.campaign_id IS NULL"); else if (f.campaign) (where.push("t.campaign_id=?"), args.push(f.campaign));
  if (f.q?.trim()) { const like = `%${f.q.trim().toLowerCase()}%`; where.push("(lower(t.title) LIKE ? OR lower(l.company) LIKE ?)"); args.push(like, like); }
  const rows = await all(
    `SELECT t.*, l.company, u.name AS assignee_name, cb.name AS created_by_name, cu.name AS completed_by_name, c.name AS campaign_name,
            sd.id AS sender_ref_id, sd.display_name AS sender_name, sd.email AS sender_email,
            (SELECT a.id FROM approvals a WHERE a.task_id=t.id AND a.status='pending' ORDER BY a.id DESC LIMIT 1) AS pending_approval_id,
            (SELECT COUNT(*) FROM task_notes n WHERE n.task_id=t.id) AS note_count
     FROM tasks t JOIN users u ON u.id=t.assignee_id JOIN users cb ON cb.id=t.created_by LEFT JOIN users cu ON cu.id=t.completed_by LEFT JOIN leads l ON l.id=t.lead_id
     LEFT JOIN campaigns c ON c.id=t.campaign_id LEFT JOIN message_versions mv ON mv.id=t.message_version_id LEFT JOIN senders sd ON sd.id=COALESCE(t.sender_id, mv.sender_id)
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.id DESC LIMIT 5000`, args);
  const today = todayYmd();
  return (await liveTasks(rows)).map((t) => enrich(t, today));
}
const weekEnd = (today: string) => { let d = today; while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) d = addDays(d, 1); return d; };
function applyFilters(rows: TaskRow[], f: TaskListFilters, today: string): TaskRow[] {
  let out = rows;
  if (f.state) out = out.filter((t) => t.live_status === f.state);
  if (f.types?.length) out = out.filter((t) => f.types!.includes(t.display_type));
  if (f.sender === "none") out = out.filter((t) => !t.sender); else if (f.sender) out = out.filter((t) => t.sender?.id === f.sender);
  if (f.blocked) out = out.filter((t) => t.state === "blocked");
  if (f.overdue || f.due === "overdue") out = out.filter((t) => t.urgency === "overdue");
  if (f.due === "today") out = out.filter((t) => t.urgency === "today");
  if (f.due === "tomorrow") out = out.filter((t) => t.urgency === "tomorrow");
  if (f.due === "none") out = out.filter((t) => t.urgency === "undated");
  if (f.due === "this_week") { const end = weekEnd(today); out = out.filter((t) => { const d = t.due_day ?? t.scheduled_day; return !!d && d >= today && d <= end && t.urgency !== "done"; }); }
  if (f.daysOverdue) out = out.filter((t) => { const d = t.days_overdue ?? 0; return f.daysOverdue === "1-2" ? d >= 1 && d <= 2 : f.daysOverdue === "3-7" ? d >= 3 && d <= 7 : d >= 8; });
  if (f.kind === "first_email") out = out.filter((t) => t.display_type === "Email 1");
  if (f.kind === "follow_up") out = out.filter((t) => /^FU\d|^LinkedIn DM|^Final/.test(t.display_type) && !t.is_late);
  if (f.kind === "late") out = out.filter((t) => !!t.is_late);
  return out;
}

export async function listTasksView(actor: Actor, f: TaskListFilters = {}) {
  const warnings: string[] = [];
  if (f.state && !(TASK_STATES as readonly string[]).includes(f.state)) { warnings.push(`state: "${f.state}" is not one of ${TASK_STATES.join(", ")}; it was ignored.`); f = { ...f, state: undefined }; }
  if (f.due && !(DUE_FILTERS as readonly string[]).includes(f.due)) { warnings.push(`due: "${f.due}" is not one of ${DUE_FILTERS.join(", ")}; it was ignored.`); f = { ...f, due: undefined }; }
  if (f.daysOverdue && !(OVERDUE_BUCKETS as readonly string[]).includes(f.daysOverdue)) { warnings.push(`days_overdue: use ${OVERDUE_BUCKETS.join(", ")}; "${f.daysOverdue}" was ignored.`); f = { ...f, daysOverdue: undefined }; }
  const badTypes = (f.types ?? []).filter((x) => !(TASK_DISPLAY_TYPES as readonly string[]).includes(x) && !/^FU\d( draft)?$/.test(x));
  if (badTypes.length) warnings.push(`type: ${badTypes.map((x) => `"${x}"`).join(", ")} not known. Types: ${TASK_DISPLAY_TYPES.join(", ")}.`);
  if (f.state === "completed" || f.state === "cancelled") f = { ...f, status: f.state };
  const today = todayYmd();
  const filtered = applyFilters(await loadTasks(actor, f), f, today);
  const sort = parseSort(f.sort, TASK_SORTS, SORT_ALIASES, f.defaultSort ?? "due");
  if (sort.warning) warnings.push(sort.warning);
  // Ties always fall back to the same order, so two pages can never show the same task: due date, scheduled date, then id.
  const base = [...filtered].sort((a, b) => compareValues(a.due_day, b.due_day) || compareValues(a.scheduled_day, b.scheduled_day) || (b.id as number) - (a.id as number));
  const sorted = sortRows(base, SORT_SPEC, sort);
  const size = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  return { rows: sorted.slice((page - 1) * size, page * size), all: sorted, total: sorted.length, page, page_size: size, has_more: page * size < sorted.length, applied_sort: sort.applied, warnings };
}

/** The numbers on the chips above the Tasks table: open work in the chosen assignee scope, not narrowed by any other filter. */
export async function taskSummary(actor: Actor, o: { assignee?: number; includeTest?: boolean } = {}) {
  const rows = await loadTasks(actor, { assignee: o.assignee, status: "open", includeTest: o.includeTest });
  const by = new Map<number, { assignee_id: number; name: string; count: number }>();
  for (const t of rows.filter((x) => x.urgency === "overdue")) { const k = t.assignee_id as number; (by.get(k) ?? by.set(k, { assignee_id: k, name: t.assignee_name as string, count: 0 }).get(k)!).count++; }
  const n = (f: (t: TaskRow) => boolean) => rows.filter(f).length;
  return {
    assignee: o.assignee ?? "all", open: rows.length,
    overdue: { total: n((t) => t.urgency === "overdue"), by_assignee: [...by.values()].sort((a, b) => b.count - a.count) },
    blocked: n((t) => t.state === "blocked"), ready: n((t) => t.state === "ready"), due_today: n((t) => t.urgency === "today"), due_tomorrow: n((t) => t.urgency === "tomorrow"), no_date: n((t) => t.urgency === "undated"),
    late_items: n((t) => !!t.is_late),
    rules: "Open tasks only (not completed, not cancelled). overdue = the due date (or the planned time, when there is no due date) has passed. due_today / due_tomorrow use the due date, or the planned date when there is no due date. All days are Asia/Hebron days.",
  };
}
export function assertAssignee(actor: Actor, v: string | null): number | undefined {
  if (!v || v === "all") return undefined;
  if (!/^\d+$/.test(v)) throw new HttpError(400, 'assignee: a user id, or "all".');
  return Number(v);
}

/** The one next step of a task, in plain words (the same rules GET /work/next uses, without the eligibility call). */
export function whatToDo(t: Row): string {
  if (t.status === "completed") return t.sent_at ? "Done: the message was sent and recorded." : "Done.";
  if (t.status === "cancelled") return "Cancelled. Nothing to do.";
  if (t.status === "changes_requested") return `Changes were requested: ${t.change_request ?? "see the history"}. Fix the work and submit it again.`;
  if (t.status === "waiting_approval") return "Submitted and waiting for a decision. Nothing to do until it is decided.";
  if (t.message_version_id && t.state === "ready") return "Approved and ready: send the approved message exactly as written, then record the send. The task closes by itself.";
  if (t.message_version_id) return `Do not send yet. ${blockerShort(t) ?? "Waiting on approvals"}.`;
  if (t.state === "blocked") return `Blocked: ${blockerShort(t) ?? "see why below"}.`;
  const type = displayType(t);
  if (/^(Email 1|FU\d|Final email)$/.test(type)) return `Write the draft for this ${type === "Email 1" ? "first email" : "follow-up"}${t.thread_subject ? ` in the same thread ("${t.thread_subject}")` : ""}. It then goes to the Chief's review and the Owner's send approval.`;
  if (/^LinkedIn/.test(type)) return "Write the LinkedIn message, get it approved, send it by hand and record it on the lead.";
  if (type === "Reply") return "Answer the reply in the same thread: draft, Chief's review, Owner's send approval.";
  if (type === "Research") return "Do the research, record what was found on the lead, then complete the task.";
  if (type === "Review") return "Decide, act on the lead if needed, then complete the task with a note.";
  if (type === "Revisit") return "Decide whether to write to this lead again. A new message is a new thread with the normal approval steps.";
  return "Do the task, record what was done, then complete it.";
}
