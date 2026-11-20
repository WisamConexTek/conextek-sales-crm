import { all, run, now, addDays, todayYmd, TZ, type Row } from "../db";
import { HttpError, isManager, type Actor } from "../auth";
import { WORK_ROLES, WORK_ROLE_LABEL, type WorkRole } from "../constants";
import { toLocalInput } from "../format";
import { capacityData, allocate, capKind, CAP_GROUPS, CAP_GROUP_LABEL, type CapGroup, type CapKind } from "./capacity";
import { roleOf, roleUsers, seqSettings, ensureReplyFollowUps } from "./sequences";
import { liveTasks } from "./taskview";
import { enrich, type TaskRow } from "./tasklist";

/**
 * The daily work plan: for one day and each sender, which sends fit the day's capacity (same priority order as the real
 * reservation), and from that what each role has to prepare. Computed on every read; nothing is stored except open shortfalls.
 */
const ROLE_PARAM: Record<string, WorkRole> = { writer: "writer", hunter: "hunter", inbox: "inbox", linkedin: "linkedin", chief: "chief", compliance: "compliance", owner: "owner" };
type PlanItem = { task_id: number; lead_id: number | null; company: string | null; type: string; title: string; kind: CapKind; sort: string; campaign_id: number | null; campaign: string | null; due_on: string | null; window_end_on: string | null;
  days_overdue: number | null; draft_deadline: string | null; has_draft: boolean; prep: string | null; status: string; thread_subject: string | null; experiment_labels: string[]; assignee: string; late: boolean };
const item = (t: TaskRow, kind: CapKind): PlanItem => ({
  task_id: t.id as number, lead_id: (t.lead_id as number) ?? null, company: (t.company as string) ?? null, type: t.display_type, title: t.display_title, kind, sort: kind === "first" ? String(t.due_day ?? "") : `${(t.window_end_on as string) ?? t.due_day ?? ""}|${t.due_day ?? ""}`,
  campaign_id: (t.campaign_id as number) ?? null, campaign: t.campaign_name, due_on: t.due_day ?? t.scheduled_day, window_end_on: (t.window_end_on as string) ?? null, days_overdue: t.days_overdue, draft_deadline: (t.draft_deadline as string) ?? null,
  has_draft: !!t.message_version_id, prep: (t.prep_status as string) ?? null, status: t.live_status, thread_subject: (t.thread_subject as string) ?? null, experiment_labels: t.experiment_labels, assignee: t.assignee_name as string, late: !!t.is_late,
});

async function compute(date: string) {
  const today = todayYmd();
  const [capD, capToday, settings, rows, camps] = await Promise.all([
    capacityData(date), date > today ? capacityData(today) : Promise.resolve(null), seqSettings(),
    all(`SELECT t.*, l.company, u.name AS assignee_name, c.name AS campaign_name, sd.id AS sender_ref_id, sd.display_name AS sender_name, sd.email AS sender_email
         FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN campaigns c ON c.id=t.campaign_id
         LEFT JOIN message_versions mv ON mv.id=t.message_version_id LEFT JOIN senders sd ON sd.id=COALESCE(t.sender_id, mv.sender_id)
         WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') ORDER BY t.id LIMIT 5000`),
    all("SELECT id,name,status FROM campaigns WHERE status='active' ORDER BY id"),
  ]);
  const tasks = (await liveTasks(rows)).map((t) => enrich(t, today));
  const sendType = (t: TaskRow) => /^(Email 1|FU\d|Final email|Reply FU)$/.test(t.display_type);
  const reservedToday = new Set<number>(capToday ? capToday.senders.flatMap((s) => [...s.reservedTasks]) : []);
  const due = (t: TaskRow) => t.due_day ?? t.scheduled_day;
  const inDay = (t: TaskRow) => { const d = due(t); return !!d && d <= date && !reservedToday.has(t.id as number); };
  const senders = capD.senders.filter((s) => s.sender.active).map((s) => {
    const mine = tasks.filter((t) => sendType(t) && t.sender?.id === s.sender.id && inDay(t) && (t.channel ?? "email") === "email").map((t) => item(t, capKind({ step_number: t.step_number, action_type: t.action_type, is_late: t.is_late, window_end_on: t.window_end_on, scheduled: null, action: /^FU|^Final/.test(t.display_type) ? "follow_up" : null }, date, settings.overdue_days)));
    const used = date === today ? s.used : 0;
    const room = s.cap === null ? Infinity : Math.max(0, s.cap - used);
    const floor = Math.max(0, Math.min(s.floor, s.cap ?? Infinity) - (date === today ? s.used_first : 0));
    const al = allocate(room, floor, settings.late_daily_limit, mine, capD.rank, true);
    const free = Number.isFinite(al.free) ? al.free : 0;
    const need = al.empty_floor + free;
    const firstsTaken = al.taken.filter((x) => x.item.kind === "first");
    const camp = camps.filter((c) => !s.sender.campaign_ids || s.sender.campaign_ids.includes(c.id as number)).sort((a, b) => capD.rank(a.id as number) - capD.rank(b.id as number))[0] ?? null;
    return {
      sender: { id: s.sender.id, email: s.sender.email, display_name: s.sender.display_name, status: s.status }, date,
      cap: s.cap, used, first_email_floor: s.floor, late_daily_limit: settings.late_daily_limit,
      slots: Object.fromEntries(CAP_GROUPS.map((g) => [g, al.counts[g]])) as Record<CapGroup, number>,
      planned: al.taken.length, empty_first_email_slots: need, not_fitting: al.pushed.length,
      first_emails: { slots: firstsTaken.length + need, prepared: firstsTaken.filter((x) => x.item.has_draft).length, with_lead_no_draft: firstsTaken.filter((x) => !x.item.has_draft).length, need_leads: need, need_with_buffer: need ? Math.ceil(need * (1 + settings.plan_buffer)) : 0, campaign: camp ? { id: camp.id, name: camp.name } : null },
      items: al.taken.map((x) => ({ ...x.item, group: x.group, group_label: CAP_GROUP_LABEL[x.group] })), pushed: al.pushed,
    };
  });
  return { today, date, settings, tasks, senders, noSender: tasks.filter((t) => sendType(t) && !t.sender && inDay(t)).map((t) => item(t, "first")) };
}
type Computed = Awaited<ReturnType<typeof compute>>;

function gapsOf(p: Computed) {
  const out: { role: WorkRole; sender_id: number; kind: string; gap: number; message: string }[] = [];
  let editorial = 0, approval = 0;
  for (const s of p.senders) {
    const name = s.sender.display_name.split(" ")[0];
    const fe = s.first_emails;
    if (fe.need_leads > 0) out.push({ role: "hunter", sender_id: s.sender.id, kind: "leads", gap: fe.need_leads, message: `${name}: ${fe.slots} first-email slot${fe.slots === 1 ? "" : "s"} on ${p.date}, ${fe.prepared + fe.with_lead_no_draft} with a lead, need ${fe.need_leads} more lead${fe.need_leads === 1 ? "" : "s"} (${fe.need_with_buffer} with the buffer).` });
    const noDraft = s.items.filter((i) => !i.has_draft);
    const fu = noDraft.filter((i) => i.kind !== "first").length;
    if (noDraft.length) out.push({ role: "writer", sender_id: s.sender.id, kind: "drafts", gap: noDraft.length, message: `${name}: ${noDraft.length} message${noDraft.length === 1 ? "" : "s"} planned for ${p.date} ${noDraft.length === 1 ? "has" : "have"} no draft${fu ? ` (${fu} follow-up${fu === 1 ? "" : "s"})` : ""}.` });
    editorial += s.items.filter((i) => i.prep === "internal_review").length;
    approval += s.items.filter((i) => i.prep === "user_approval_needed").length;
  }
  if (editorial) out.push({ role: "chief", sender_id: 0, kind: "editorial", gap: editorial, message: `${editorial} draft${editorial === 1 ? "" : "s"} planned for ${p.date} ${editorial === 1 ? "is" : "are"} waiting for the Chief's review.` });
  if (approval) out.push({ role: "owner", sender_id: 0, kind: "send_approval", gap: approval, message: `${approval} draft${approval === 1 ? "" : "s"} planned for ${p.date} ${approval === 1 ? "is" : "are"} waiting for the Owner's approval.` });
  return out;
}

/**
 * Shortfalls are tomorrow's gaps that are still open after a role's cutoff time today. They are stored so they can be reported once
 * (dashboard, GET /changes) and they close by themselves when the gap closes.
 */
export async function syncShortfalls(p?: Computed) {
  const today = todayYmd();
  const date = addDays(today, 1);
  const plan = p && p.date === date ? p : await compute(date);
  const clock = toLocalInput(now()).slice(11, 16);
  const cut = plan.settings.cutoffs as Record<string, string>;
  const due = gapsOf(plan).filter((g) => clock >= (cut[g.role] ?? "23:59"));
  const t = now();
  for (const g of due)
    await run(`INSERT INTO plan_shortfalls (plan_date,role,sender_id,kind,message,gap,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,'open',?,?)
               ON CONFLICT(plan_date,role,sender_id,kind) DO UPDATE SET message=excluded.message, gap=excluded.gap, last_seen=excluded.last_seen, status='open', resolved_at=NULL`, [date, g.role, g.sender_id, g.kind, g.message, g.gap, t, t]);
  const open = await all("SELECT * FROM plan_shortfalls WHERE status='open'");
  for (const o of open) if (o.plan_date !== date || !due.some((g) => g.role === o.role && g.sender_id === o.sender_id && g.kind === o.kind)) await run("UPDATE plan_shortfalls SET status='resolved', resolved_at=? WHERE id=?", [t, o.id as number]);
  return all("SELECT id,plan_date,role,sender_id,kind,message,gap,first_seen,last_seen FROM plan_shortfalls WHERE status='open' ORDER BY id");
}

export async function workPlan(actor: Actor, o: { date?: string | null; role?: string | null; sender_id?: number } = {}) {
  const today = todayYmd();
  const date = o.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date: YYYY-MM-DD.");
  if (date < today || date > addDays(today, 5)) throw new HttpError(400, "date: today or up to 5 days ahead.");
  const mine = await roleOf(actor);
  const seeAll = isManager(actor) || actor.perms.has("compliance.view");
  let role: WorkRole | null = null;
  if (o.role) {
    role = ROLE_PARAM[o.role] ?? null;
    if (!role) throw new HttpError(400, `role: one of ${Object.keys(ROLE_PARAM).join(", ")}.`);
    if (!seeAll && role !== mine) throw new HttpError(403, `You can only read your own view of the plan${mine ? ` (role=${mine})` : ""}. The Owner and the Chief see every view.`);
  } else if (!seeAll) {
    if (!mine) throw new HttpError(403, "Your account has no role in the work plan. Ask the Owner to map it in Settings.");
    role = mine;
  }
  await ensureReplyFollowUps();
  const p = await compute(date);
  const senders = o.sender_id ? p.senders.filter((s) => s.sender.id === o.sender_id) : p.senders;
  const shortfalls = await syncShortfalls(date === addDays(today, 1) ? p : undefined);
  const roles = await roleUsers(p.settings);
  const open = p.tasks;
  const dueBy = (t: TaskRow) => { const d = t.due_day ?? t.scheduled_day; return !d || d <= date; };
  const brief = (t: TaskRow) => ({ task_id: t.id, title: t.display_title, type: t.display_type, lead_id: t.lead_id ?? null, company: t.company ?? null, due_on: t.due_day, due_at: t.due_on ? null : t.due_at, days_overdue: t.days_overdue, status: t.live_status, assignee: t.assignee_name, blocker: t.blocker_short });
  const views: Record<WorkRole, () => unknown> = {
    writer: () => ({
      total_to_draft: senders.reduce((a, s) => a + s.items.filter((i) => !i.has_draft).length + s.first_emails.need_leads, 0),
      drafting_deadline_default: `${p.settings.draft_deadline_time} ${TZ()} the day before the planned send`,
      senders: senders.map((s) => ({ sender: s.sender, to_draft: s.items.filter((i) => !i.has_draft).length + s.first_emails.need_leads, done: s.items.filter((i) => i.has_draft).length,
        items: s.items.map((i) => ({ ...i, kind_label: i.kind === "first" ? "New (Email 1)" : `Follow-up step ${/\d/.exec(i.type)?.[0] ? Number(/\d/.exec(i.type)![0]) + 1 : ""}`.trim(), draft: i.has_draft ? "done" : "to draft" })),
        new_first_emails_waiting_for_a_lead: s.first_emails.need_leads })),
      without_sender: p.noSender,
    }),
    hunter: () => ({
      needs: senders.map((s) => ({ sender: s.sender, campaign: s.first_emails.campaign, first_email_slots: s.first_emails.slots, prepared: s.first_emails.prepared + s.first_emails.with_lead_no_draft, need_leads: s.first_emails.need_leads, need_with_buffer: s.first_emails.need_with_buffer })),
      buffer: p.settings.plan_buffer, total_need: senders.reduce((a, s) => a + s.first_emails.need_leads, 0), total_need_with_buffer: senders.reduce((a, s) => a + s.first_emails.need_with_buffer, 0),
      research_tasks: open.filter((t) => t.display_type === "Research" && (t.assignee_id === roles.hunter || /referred|alternate|find_contact/.test(String(t.action_type)))).map(brief),
      rule: "need_leads = the first-email slots left after follow-ups, the protected minimum and late items, minus first emails that already have a lead. need_with_buffer adds the buffer, rounded up.",
    }),
    inbox: () => ({ handle_reply: open.filter((t) => t.display_type === "Reply").map(brief), waiting: open.filter((t) => t.hold_reason && /soft bounce|out of office/i.test(String(t.hold_reason))).map((t) => ({ ...brief(t), reason: t.hold_reason })) }),
    linkedin: () => ({ steps_due: open.filter((t) => /^LinkedIn/.test(t.display_type) && dueBy(t)).map(brief), upcoming: open.filter((t) => /^LinkedIn/.test(t.display_type) && !dueBy(t)).map(brief), note: "Record an accepted invitation with POST /leads/{id}/activities {type: \"note\", channel: \"linkedin\", event: \"linkedin_accepted\"}; it plans the first message." }),
    chief: () => ({
      waiting_editorial_review: senders.flatMap((s) => s.items.filter((i) => i.prep === "internal_review").map((i) => ({ ...i, sender: s.sender.display_name, deadline: i.due_on }))),
      waiting_owner_send_approval: senders.flatMap((s) => s.items.filter((i) => i.prep === "user_approval_needed").map((i) => ({ ...i, sender: s.sender.display_name, deadline: i.due_on }))),
      reviews: open.filter((t) => t.display_type === "Review").map(brief), not_fitting_the_day: senders.flatMap((s) => s.pushed.map((i) => ({ ...i, sender: s.sender.display_name }))), shortfalls,
    }),
    compliance: () => ({ note: "Today's compliance items are in GET /compliance/report.", open_shortfalls: shortfalls.length, late_items: open.filter((t) => t.is_late).length, overdue_follow_ups: open.filter((t) => /^FU/.test(t.display_type) && (t.days_overdue ?? 0) > 0).length }),
    owner: () => ({
      planned_sends: senders.map((s) => ({ sender: s.sender, cap: s.cap, planned: s.planned, slots: s.slots, empty_first_email_slots: s.empty_first_email_slots, not_fitting: s.not_fitting })),
      approvals_waiting: senders.reduce((a, s) => a + s.items.filter((i) => i.prep === "user_approval_needed").length, 0), earliest_deadline: senders.flatMap((s) => s.items.filter((i) => i.prep === "user_approval_needed").map((i) => i.due_on)).sort()[0] ?? null, shortfalls,
    }),
  };
  const base = { date, today, timezone: TZ(), your_role: mine, roles: Object.fromEntries(WORK_ROLES.map((r) => [r, { label: WORK_ROLE_LABEL[r], user_id: roles[r] }])), gaps: gapsOf({ ...p, senders }).filter((g) => !role || g.role === role || role === "chief" || role === "owner"),
    cutoffs: p.settings.cutoffs, priority_order: CAP_GROUPS.map((g, i) => ({ position: i + 1, group: g, label: CAP_GROUP_LABEL[g] })) };
  if (role) return { ...base, role, view: views[role]() };
  return { ...base, role: null, senders, shortfalls, views: Object.fromEntries(WORK_ROLES.map((r) => [r, views[r]()])) };
}
