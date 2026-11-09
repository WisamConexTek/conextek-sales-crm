import { all, now, type Row } from "../db";
import { toLocalInput } from "../format";
import { readiness } from "./sends";

/**
 * One definition of a task's REAL status, used by the schedule, the task list, the task page, the lead page and the API.
 * It never trusts stored blocker text for a task that is linked to a message version: approvals decide.
 */
export const STATES = ["overdue", "blocked", "ready", "planned", "completed"] as const;
export type WorkState = (typeof STATES)[number];

/** A date-only deadline is kept as a pure date (due_on / scheduled_on). The column holding its end-of-day cutoff is internal. */
export const dateOnlyOf = (iso?: string | null): string | null => {
  if (!iso) return null;
  const l = toLocalInput(iso);
  return l.endsWith("T23:59") ? l.slice(0, 10) : null;
};

export type LiveTask = Row & { rescheduled_from_on: string | null; state: WorkState; is_overdue: boolean; blocked_reason: string | null; prep_label: string | null; reason: string | null; date_only: boolean; on: string | null; due_overdue: boolean };

export async function liveTasks(rows: Row[]): Promise<LiveTask[]> {
  const nowISO = now();
  const leadIds = [...new Set(rows.filter((r) => r.opted_out === undefined && r.lead_id).map((r) => r.lead_id as number))];
  const optedOut = new Map<number, number>();
  if (leadIds.length) for (const o of await all(`SELECT lead_id, COUNT(*) AS n FROM contacts WHERE email_status='opted_out' AND lead_id IN (${leadIds.map(() => "?").join(",")}) GROUP BY lead_id`, leadIds)) optedOut.set(o.lead_id as number, Number(o.n));
  // completed tasks that point at a recorded send: the send time is the real time
  const doneActs = [...new Set(rows.filter((r) => r.status === "completed" && r.activity_id && !r.sent_at).map((r) => r.activity_id as number))];
  const actSent = new Map<number, string>();
  if (doneActs.length) for (const a of await all(`SELECT id, occurred_at FROM activities WHERE type='message' AND outcome='sent' AND occurred_precision='time' AND id IN (${doneActs.map(() => "?").join(",")})`, doneActs)) actSent.set(a.id as number, a.occurred_at as string);
  const out: LiveTask[] = [];
  for (const r0 of rows) {
    let r = r0;
    const done = r.status === "completed" || r.status === "cancelled";
    if (done) {
      // a finished task carries a final state, never the old preparation text
      const sentAt = (r.sent_at as string | null) ?? actSent.get(r.activity_id as number) ?? null;
      r = { ...r, sent_at: sentAt, prep_status: r.status === "cancelled" ? "cancelled" : sentAt ? "sent" : "completed", blockers: null } as Row;
    }
    const at = ((r.scheduled_at ?? r.due_at) as string | null) ?? null;
    const atIsScheduled = r.scheduled_at != null;
    let label: string | null = null;
    let sentNote: string | null = null;
    if (!done && r.message_version_id) {
      const live = await readiness(r.message_version_id as number);
      if (live.state === "sent") sentNote = "A send was already recorded for this message, but the task is still open (Owner/Chief can close it: POST /tasks/{id}/complete).";
      else r = { ...r, prep_status: live.prep_status, blockers: live.blockers } as Row;
      label = live.label;
    }
    const opted = Number(r.opted_out ?? optedOut.get(r.lead_id as number) ?? 0);
    const overdue = !done && !!at && at < nowISO;
    const blocked = !done && (!!(r.blockers as string | null)?.trim() || r.prep_status === "validation_needed" || opted > 0 || !!sentNote);
    const state: WorkState = done ? "completed" : blocked ? "blocked" : overdue ? "overdue" : r.prep_status === "ready_for_execution" ? "ready" : "planned";
    const blockedReason = blocked ? (opted > 0 ? "lead has an opted-out contact" : sentNote ?? ((r.blockers as string) || "validation needed")) : null;
    const hold = !done && r.hold_reason ? `Held: ${r.hold_reason}` : null;
    const reason = done ? null : blockedReason ?? hold ?? (state === "overdue" ? (r.prep_status === "ready_for_execution" ? "Approved and ready, but not sent yet; its time has passed." : "Its time has passed and the work is not finished.") : null);
    const dateOnly = atIsScheduled ? !!r.scheduled_on : !!r.due_on;
    out.push({
      ...r,
      // no fake time of day: a date-only value is shown as a pure date
      due_at: r.due_on ? null : r.due_at, scheduled_at: r.scheduled_on ? null : r.scheduled_at,
      state, is_overdue: overdue, blocked_reason: blockedReason, reason,
      date_only: dateOnly, on: dateOnly ? ((atIsScheduled ? r.scheduled_on : r.due_on) as string) : null,
      rescheduled_from: r.rescheduled_from && dateOnlyOf(r.rescheduled_from as string) ? null : r.rescheduled_from ?? null,
      rescheduled_from_on: r.rescheduled_from ? dateOnlyOf(r.rescheduled_from as string) : null,
      prep_label: label ?? (done ? (r.status === "cancelled" ? "Cancelled" : r.sent_at ? "Sent" : "Completed") : null),
      due_overdue: !done && !!r.due_at && (r.due_at as string) < nowISO,
    } as LiveTask);
  }
  return out;
}
