import { z } from "zod";
import { all, one, run, now, addDays, todayYmd, localMidnight, TZ, type Row } from "../db";
import { HttpError, isManager, type Actor } from "../auth";
import { audit, parse, optText } from "./common";
import { liveTasks } from "./taskview";
import { toLocalInput } from "../format";
import { enrich } from "./tasklist";
import { capacityData } from "./capacity";
import { seqSettings, parseLabels } from "./sequences";
import { addSuppression } from "./inbound";

/** Who may read compliance data: the Owner, a Chief, and the read-only compliance monitor. */
export function assertCompliance(actor: Actor) {
  if (!isManager(actor) && !actor.perms.has("compliance.view")) throw new HttpError(403, "Compliance reports are for the Owner, the Chief and the compliance monitor.");
}

/* ---------- suppression list ---------- */
export async function listSuppressions(actor: Actor, q: { kind?: string | null; q?: string | null; limit?: number } = {}) {
  assertCompliance(actor);
  const where: string[] = ["1=1"]; const args: (string | number)[] = [];
  if (q.kind) (where.push("kind=?"), args.push(q.kind));
  if (q.q) (where.push("value LIKE ?"), args.push(`%${q.q.toLowerCase()}%`));
  const [rows, counts, last] = await Promise.all([
    all(`SELECT id,kind,scope,value,occurred_at,source,note,lead_id,created_at FROM suppressions WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, [...args, Math.min(Math.max(q.limit ?? 500, 1), 5000)]),
    all("SELECT kind, COUNT(*) AS n FROM suppressions GROUP BY kind"),
    one("SELECT created_at, detail FROM audit_log WHERE action='suppression_import' ORDER BY id DESC LIMIT 1"),
  ]);
  return { total: counts.reduce((a, c) => a + Number(c.n), 0), by_kind: Object.fromEntries(counts.map((c) => [c.kind as string, Number(c.n)])), last_import_at: (last?.created_at as string) ?? null,
    completeness: last ? "An import of the earlier do-not-contact, opt-out and bounce logs was run; see last_import_at." : "No import has been run yet. This list may be incomplete compared with the do-not-contact, opt-out and bounce logs kept before the CRM.", entries: rows };
}
const importSchema = z.object({
  dry_run: z.boolean().optional(),
  entries: z.array(z.object({ email: optText(300).optional(), domain: optText(300).optional(), kind: z.enum(["dnc", "opt_out", "bounce"]), occurred_at: optText(40).optional(), source: optText(200).optional(), note: optText(500).optional() })).min(1).max(5000),
});
/** Owner and Chief. Idempotent: an entry that is already on the list is counted as existing, never doubled. dry_run (default) changes nothing. */
export async function importSuppressions(actor: Actor, input: unknown) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or a Chief can import suppression entries.");
  const d = parse(importSchema, input);
  const dry = d.dry_run !== false;
  const out = { dry_run: dry, received: d.entries.length, added: 0, already_listed: 0, invalid: [] as { index: number; error: string }[], matches: [] as { value: string; kind: string; lead_id: number; company: string; contact_id: number | null; contact_status_change: string | null }[] };
  for (const [i, e] of d.entries.entries()) {
    const email = e.email?.toLowerCase() ?? null, domain = e.domain?.toLowerCase().replace(/^@/, "") ?? null;
    if ((!email && !domain) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) { out.invalid.push({ index: i, error: "give a valid email or domain" }); continue; }
    const scope = email ? "email" : "domain", value = (email ?? domain)!;
    const exists = await one("SELECT id FROM suppressions WHERE kind=? AND scope=? AND value=?", [e.kind, scope, value]);
    const hits = email
      ? await all("SELECT c.id AS contact_id,c.email_status,l.id AS lead_id,l.company FROM contacts c JOIN leads l ON l.id=c.lead_id WHERE lower(c.email)=?", [email])
      : await all("SELECT NULL AS contact_id,NULL AS email_status,l.id AS lead_id,l.company FROM leads l WHERE l.domain=? OR EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND lower(c.email) LIKE ?)", [value, `%@${value}`]);
    for (const h of hits) {
      const change = email && e.kind === "opt_out" && h.email_status !== "opted_out" ? "opted_out" : email && e.kind === "bounce" && !["bounced", "opted_out"].includes(String(h.email_status)) ? "bounced" : null;
      out.matches.push({ value, kind: e.kind, lead_id: h.lead_id as number, company: h.company as string, contact_id: (h.contact_id as number) ?? null, contact_status_change: change });
      if (!dry && change) await run("UPDATE contacts SET email_status=?, updated_at=? WHERE id=?", [change, now(), h.contact_id as number]);
    }
    if (exists) { out.already_listed++; continue; }
    out.added++;
    if (!dry) await addSuppression(actor, { kind: e.kind, scope, value, source: e.source ?? "import", note: e.note ?? null, occurred_at: e.occurred_at ?? null, lead_id: (hits[0]?.lead_id as number) ?? null });
  }
  if (!dry) await audit(actor, "suppression_import", "suppression", null, { received: out.received, added: out.added, already_listed: out.already_listed, matches: out.matches.length });
  return { ...out, note: dry ? "Dry run: nothing was changed. Send dry_run:false to commit." : "Committed. A matching contact is marked opted out or bounced; a suppressed address or domain fails the eligibility check with code suppressed." };
}
export async function removeSuppression(actor: Actor, id: number, reason: unknown) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can remove a suppression entry.");
  const why = parse(z.string().trim().min(3, "reason: say why").max(500), reason);
  const s = await one("SELECT * FROM suppressions WHERE id=?", [id]);
  if (!s) throw new HttpError(404, "Suppression entry not found.");
  await run("DELETE FROM suppressions WHERE id=?", [id]);
  await audit(actor, "suppression_removed", "suppression", id, { entry: s, reason: why });
  return { removed: true };
}

/* ---------- the daily report ---------- */
const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3600000;
export async function complianceReport(actor: Actor, date?: string | null) {
  assertCompliance(actor);
  const today = todayYmd();
  const day = date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "date: YYYY-MM-DD.");
  const settings = await seqSettings();
  const [taskRows, noNext, replies, supp, cap] = await Promise.all([
    all(`SELECT t.*, l.company, u.name AS assignee_name, c.name AS campaign_name, sd.id AS sender_ref_id, sd.display_name AS sender_name, sd.email AS sender_email, mv.created_at AS draft_at
         FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN campaigns c ON c.id=t.campaign_id
         LEFT JOIN message_versions mv ON mv.id=t.message_version_id LEFT JOIN senders sd ON sd.id=COALESCE(t.sender_id, mv.sender_id)
         WHERE t.is_demo=0 AND t.status NOT IN ('completed','cancelled') AND (t.step_number>1 OR t.action_type LIKE '%follow%' COLLATE NOCASE OR t.message_version_id IS NOT NULL OR t.enrollment_id IS NOT NULL) ORDER BY t.id LIMIT 5000`),
    all(`SELECT l.id AS lead_id,l.company,l.stage,(SELECT c.name FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.lead_id=l.id AND lc.status='active' ORDER BY lc.id LIMIT 1) AS campaign,
                (SELECT MAX(a.occurred_at) FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent') AS last_sent_at,
                (SELECT COUNT(*) FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent') AS sent
         FROM leads l WHERE l.is_demo=0 AND l.historical_only=0
           AND EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent')
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND t.status NOT IN ('completed','cancelled'))
           AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.status IN ('resting','paused'))
           AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed'))
           AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')
         ORDER BY last_sent_at LIMIT 2000`),
    all(`SELECT a.id,a.lead_id,l.company,a.occurred_at,a.classification,a.title,
                (SELECT t.id FROM tasks t WHERE t.lead_id=a.lead_id AND t.action_type='handle_reply' AND t.status NOT IN ('completed','cancelled') LIMIT 1) AS task_id,
                (SELECT t.due_at FROM tasks t WHERE t.lead_id=a.lead_id AND t.action_type='handle_reply' AND t.status NOT IN ('completed','cancelled') LIMIT 1) AS deadline
         FROM activities a JOIN leads l ON l.id=a.lead_id
         WHERE a.type='reply' AND a.is_demo=0 AND a.occurred_at>=? AND COALESCE(a.classification,'other') IN ('interested','soft','other','referral')
           AND NOT EXISTS (SELECT 1 FROM activities m WHERE m.lead_id=a.lead_id AND m.type='message' AND m.occurred_at>a.occurred_at)
           AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed','meeting'))
         ORDER BY a.occurred_at LIMIT 500`, [new Date(Date.now() - 60 * 86400000).toISOString()]),
    one("SELECT (SELECT COUNT(*) FROM suppressions) AS n, (SELECT created_at FROM audit_log WHERE action='suppression_import' ORDER BY id DESC LIMIT 1) AS last_import"),
    capacityData(today),
  ]);
  const pushed = new Set(cap.senders.flatMap((s) => s.pushed.map((p) => p.task_id)));
  const tasks = (await liveTasks(taskRows)).map((t) => enrich(t, today));
  const stateOf = (t: (typeof tasks)[number]) => !t.message_version_id ? "no draft" : pushed.has(t.id as number) ? "pushed by the daily cap" : t.prep_status === "internal_review" ? "waiting for editorial review" : t.prep_status === "user_approval_needed" ? "waiting for send approval" : t.prep_status === "ready_for_execution" ? "approved but not sent" : t.prep_status === "draft_needed" ? "draft rejected, new draft needed" : "approved but blocked";
  const row = (t: (typeof tasks)[number], rule: string, reason: string) => ({ rule, reason, task_id: t.id, lead_id: t.lead_id ?? null, company: t.company ?? null, campaign: t.campaign_name, sender: t.sender?.display_name ?? null, step: t.display_type, due_on: t.due_day, window_end_on: t.window_end_on ?? null, days_overdue: t.days_overdue ?? 0, state: stateOf(t), assignee: t.assignee_name, late_item: !!t.is_late });
  const followUps = tasks.filter((t) => /^FU\d$|^LinkedIn DM|^Final/.test(t.display_type));
  const s1 = followUps.filter((t) => t.due_day && t.due_day <= day).map((t) => row(t, "REQ-QC-03.1", `${t.display_type} was due ${t.due_day} and is not sent (${stateOf(t)}).`)).sort((a, b) => b.days_overdue - a.days_overdue);
  const s2 = noNext.map((l) => ({ rule: "REQ-QC-03.2", reason: "Contacted, still open, and nothing is planned: no open task and no resting sequence.", lead_id: l.lead_id, company: l.company, campaign: l.campaign ?? null, stage: l.stage, messages_sent: Number(l.sent), last_sent_at: l.last_sent_at }));
  const sendTasks = tasks.filter((t) => /^(Email 1|FU\d|Final email|LinkedIn DM\d)$/.test(t.display_type));
  const nowIso = now();
  const s3 = [
    ...sendTasks.filter((t) => !t.message_version_id && t.draft_deadline && (t.draft_deadline as string) < nowIso).map((t) => row(t, "REQ-QC-03.3a", `No draft by its drafting deadline (${toLocalInput(t.draft_deadline as string).replace("T", " ")} ${TZ()}).`)),
    ...sendTasks.filter((t) => t.prep_status === "internal_review" && t.draft_at && hoursSince(t.draft_at as string) > settings.editorial_sla_hours).map((t) => row(t, "REQ-QC-03.3b", `The draft has waited more than ${settings.editorial_sla_hours} hours for editorial review.`)),
    ...sendTasks.filter((t) => t.prep_status === "user_approval_needed" && t.due_day && t.due_day <= day).map((t) => row(t, "REQ-QC-03.3c", "The draft is still waiting for the Owner's send approval on its due date.")),
    ...sendTasks.filter((t) => t.prep_status === "ready_for_execution" && ((t.window_end_on as string | null) ?? t.due_day ?? "9999") < day).map((t) => row(t, "REQ-QC-03.3d", "Approved, but not sent by the end of its window.")),
  ];
  const s4 = replies.filter((r) => (r.deadline ? (r.deadline as string) < nowIso : hoursSince(r.occurred_at as string) > settings.reply_sla_hours * 3)).map((r) => ({ rule: "REQ-QC-03.4", reason: `A ${r.classification ?? "human"} reply has no answer yet${r.deadline ? ` and its deadline (${r.deadline}) has passed` : ""}.`, lead_id: r.lead_id, company: r.company, received_at: r.occurred_at, classification: r.classification, handling_task_id: r.task_id ?? null, deadline: r.deadline ?? null, hours_waiting: Math.round(hoursSince(r.occurred_at as string)) }));
  return {
    date: day, generated_at: nowIso, timezone: TZ(), thresholds: { reply_sla_working_hours: settings.reply_sla_hours, editorial_review_hours: settings.editorial_sla_hours },
    summary: { follow_ups_due_not_sent: s1.length, overdue_follow_ups: s1.filter((x) => x.days_overdue > 0).length, active_contacted_leads_without_next_step: s2.length, stalled: s3.length, replies_not_handled_in_time: s4.length },
    suppression: { entries: Number(supp!.n), last_import_at: (supp!.last_import as string) ?? null, may_be_incomplete: !supp!.last_import, note: supp!.last_import ? null : "The CRM suppression list may be incomplete compared with the earlier local do-not-contact, opt-out and bounce logs until they are imported (POST /suppressions/import)." },
    sections: {
      follow_ups_due_not_sent: s1, active_contacted_leads_without_next_step: s2, stalled_sequences: s3, replies_not_handled_in_time: s4,
    },
    route: "Findings go to the Chief, who decides and acts. The compliance monitor reads only.",
  };
}

/* ---------- experiment results by label ---------- */
export async function experimentReport(actor: Actor, q: { label?: string | null; from?: string | null; to?: string | null; include_late?: boolean }) {
  if (!isManager(actor) && !actor.perms.has("reports.view")) throw new HttpError(403, "You cannot read reports.");
  const label = (q.label ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!label) throw new HttpError(400, "label: the experiment name, for example MI or LANG (variants are MI-A, MI-B).");
  const ok = (v?: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = ok(q.from) ? localMidnight(ok(q.from)!).toISOString() : "0000";
  const to = ok(q.to) ? localMidnight(addDays(ok(q.to)!, 1)).toISOString() : "9999";
  const rows = await all(
    `SELECT a.id,a.lead_id,a.type,a.outcome,a.classification,a.labels,a.step_code,COALESCE(a.sender_id,1) AS sender_id,a.parent_id FROM activities a
     WHERE a.is_demo=0 AND a.labels LIKE ? AND a.occurred_at>=? AND a.occurred_at<?`, [`%"${label}-%`, from, to]);
  const senders = new Map((await all("SELECT id,display_name FROM senders")).map((s) => [s.id as number, s.display_name as string]));
  const optOuts = new Set((await all("SELECT DISTINCT lead_id FROM contacts WHERE email_status='opted_out'")).map((r) => r.lead_id as number));
  type Cell = { variant: string; step: string; sender: string; sent: number; replies: number; positive_replies: number; bounces: number; opt_outs: number; reply_rate: number | null };
  const cells = new Map<string, Cell>();
  const leadsOf = new Map<string, Set<number>>();
  const cell = (variant: string, step: string, sender: string) => { const k = `${variant}|${step}|${sender}`; return cells.get(k) ?? cells.set(k, { variant, step, sender, sent: 0, replies: 0, positive_replies: 0, bounces: 0, opt_outs: 0, reply_rate: null }).get(k)!; };
  const sends = rows.filter((r) => r.type === "message" && r.outcome === "sent");
  let lateExcluded = 0;
  const lastStep = new Map<number, { variant: string; step: string; sender: string }>();
  for (const s of sends) {
    const labels = parseLabels(s.labels);
    if (labels.includes("LATE") && !q.include_late) { lateExcluded++; continue; }
    const variant = labels.find((l) => l.toUpperCase().startsWith(`${label}-`));
    if (!variant) continue;
    const key = { variant, step: (s.step_code as string) ?? "E1", sender: senders.get(s.sender_id as number) ?? `sender ${s.sender_id}` };
    cell(key.variant, key.step, key.sender).sent++;
    lastStep.set(s.lead_id as number, key);
    const lk = `${key.variant}|${key.step}|${key.sender}`;
    (leadsOf.get(lk) ?? leadsOf.set(lk, new Set()).get(lk)!).add(s.lead_id as number);
  }
  for (const r of rows) {
    const k = lastStep.get(r.lead_id as number);
    if (!k) continue;
    const c = cell(k.variant, k.step, k.sender);
    if (r.type === "reply") { c.replies++; if (r.classification === "interested") c.positive_replies++; }
    if (r.outcome === "bounced") c.bounces++;
  }
  for (const [k, set] of leadsOf) cells.get(k)!.opt_outs = [...set].filter((id) => optOuts.has(id)).length;
  const out = [...cells.values()].map((c) => ({ ...c, reply_rate: c.sent ? c.replies / c.sent : null })).sort((a, b) => a.variant.localeCompare(b.variant) || a.step.localeCompare(b.step) || a.sender.localeCompare(b.sender));
  const variants = [...new Set(out.map((c) => c.variant))].map((v) => { const mine = out.filter((c) => c.variant === v); const sent = mine.reduce((a, c) => a + c.sent, 0), replies = mine.reduce((a, c) => a + c.replies, 0); return { variant: v, sent, replies, positive_replies: mine.reduce((a, c) => a + c.positive_replies, 0), bounces: mine.reduce((a, c) => a + c.bounces, 0), opt_outs: mine.reduce((a, c) => a + c.opt_outs, 0), reply_rate: sent ? replies / sent : null }; });
  return { label, from: ok(q.from), to: ok(q.to), include_late: !!q.include_late, late_items_excluded: lateExcluded, variants, by_step_and_sender: out,
    rules: "Replies are human replies only (out-of-office and auto-replies are not counted). A reply, bounce or opt-out is counted against the last labelled step sent to that lead. Items labelled LATE are left out unless include_late=1." };
}
export type ComplianceRow = Row;
