import { z } from "zod";
import { all, one, run, now, type Row } from "../db";
import { HttpError, can, isManager, requirePerm, type Actor } from "../auth";
import { audit, parse, optText, domainOf } from "./common";
import { leadScope } from "./leads";

/* Global identity check. It reads every lead (so it works for an employee who cannot browse others' leads) but only
   reveals details of leads that employee may open; for the rest it returns a restricted reference. */

const STOP = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "limited", "the", "and", "&", "group", "gmbh", "llp"]);
export const normName = (s?: string | null) =>
  (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).join(" ");
export const normPhone = (s?: string | null) => { const d = (s ?? "").replace(/\D/g, ""); return d.length >= 7 ? d.slice(-9) : ""; };
export const normProfile = (s?: string | null) => (s ?? "").toLowerCase().trim().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

export type Identity = { company?: string | null; website?: string | null; emails?: string[]; phones?: string[]; profiles?: string[] };
type Signal = { kind: "email" | "domain" | "name" | "phone" | "profile"; strength: "strong" | "weak" };

export async function checkIdentity(actor: Actor, q: Identity, excludeLeadId?: number) {
  const name = normName(q.company);
  const domain = domainOf(q.website);
  const emails = new Set((q.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const phones = new Set((q.phones ?? []).map(normPhone).filter(Boolean));
  const profiles = new Set((q.profiles ?? []).map(normProfile).filter(Boolean));
  const leads = await all("SELECT id,company,domain,stage,owner_id,historical_only FROM leads WHERE is_demo=0");
  const contacts = await all("SELECT lead_id,email,phone,linkedin,other_social,email_status FROM contacts");
  const byLead = new Map<number, Row[]>();
  for (const c of contacts) (byLead.get(c.lead_id) ?? byLead.set(c.lead_id, []).get(c.lead_id)!).push(c);
  const scope = leadScope(actor);
  const visible = new Set((await all(`SELECT l.id FROM leads l WHERE ${scope.sql}`, scope.args)).map((r) => r.id as number));

  const found: { lead: Row; signals: Signal[] }[] = [];
  for (const l of leads) {
    if (l.id === excludeLeadId) continue;
    const signals: Signal[] = [];
    const cs = byLead.get(l.id) ?? [];
    if (cs.some((c) => c.email && emails.has(String(c.email).toLowerCase()))) signals.push({ kind: "email", strength: "strong" });
    const sameName = !!name && normName(l.company) === name;
    if (domain && l.domain === domain) signals.push({ kind: "domain", strength: sameName ? "strong" : "weak" }); // shared domains happen (franchises)
    if (sameName) signals.push({ kind: "name", strength: domain && l.domain === domain ? "strong" : "weak" });
    if (cs.some((c) => c.phone && phones.has(normPhone(c.phone)))) signals.push({ kind: "phone", strength: "weak" });
    if (cs.some((c) => [c.linkedin, c.other_social].some((p) => p && profiles.has(normProfile(String(p)))))) signals.push({ kind: "profile", strength: "weak" });
    if (signals.length) found.push({ lead: l, signals });
  }
  const matches = [];
  for (const { lead, signals } of found) {
    const camps = await all("SELECT c.name,lc.status FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.lead_id=?", [lead.id]);
    const restricted = (byLead.get(lead.id) ?? []).some((c) => c.email_status === "opted_out");
    const strong = signals.some((s) => s.strength === "strong");
    const open = visible.has(lead.id) || can(actor, "leads.view_all") || isManager(actor);
    matches.push({
      class: strong ? "duplicate" : "ambiguous",
      signals: signals.map((s) => `${s.kind}${s.strength === "weak" ? " (weak)" : ""}`),
      lead_id: open ? lead.id : null,
      company: open ? lead.company : null,
      stage: open ? lead.stage : null,
      restricted_reference: open ? null : "exists but is not visible to you — ask a Chief",
      campaigns: camps.map((c) => ({ name: c.name, status: c.status })),
      do_not_contact: restricted,
      historical_only: !!lead.historical_only,
      _id: lead.id as number,
    });
  }
  const decision = matches.some((m) => m.class === "duplicate") ? "duplicate" : matches.length ? "review" : "clear";
  return { decision, matches: matches.map(({ _id, ...m }) => (void _id, m)), _ids: matches.map((m) => m._id) };
}

const reviewSchema = z.object({
  existing_lead_id: z.coerce.number().int(),
  proposed: z.object({ company: z.string().optional(), website: z.string().optional(), emails: z.array(z.string()).optional(), phones: z.array(z.string()).optional(), profiles: z.array(z.string()).optional() }).passthrough(),
  note: optText(500).optional(),
});

/** An employee sends an ambiguous match to Chief. Open reviews are de-duplicated per (existing lead, proposed identity). */
export async function requestReview(actor: Actor, input: unknown) {
  requirePerm(actor, "leads.create");
  const d = parse(reviewSchema, input);
  if (!(await one("SELECT id FROM leads WHERE id=?", [d.existing_lead_id]))) throw new HttpError(400, "existing_lead_id: unknown lead.");
  const key = JSON.stringify(d.proposed);
  const open = await one("SELECT id FROM duplicate_reviews WHERE existing_lead_id=? AND proposed=? AND status='pending'", [d.existing_lead_id, key]);
  if (open) return { id: open.id as number, created: false };
  const res = await checkIdentity(actor, d.proposed as Identity);
  const r = await run("INSERT INTO duplicate_reviews (existing_lead_id,proposed,signals,requested_by,note,created_at) VALUES (?,?,?,?,?,?)",
    [d.existing_lead_id, key, JSON.stringify(res.matches.map((m) => m.signals)), actor.id, d.note ?? null, now()]);
  await audit(actor, "request_duplicate_review", "lead", d.existing_lead_id, { review_id: r.id });
  return { id: r.id, created: true };
}

export async function listReviews(actor: Actor, status = "pending") {
  if (!can(actor, "approvals.decide") && !isManager(actor)) throw new HttpError(403, "Only Chief or the Owner can review possible duplicates.");
  return all(
    `SELECT r.id,r.existing_lead_id,l.company AS existing_company,r.proposed,r.signals,r.status,r.note,r.created_at,u.name AS requested_by_name,d.name AS decided_by_name,r.decided_at
     FROM duplicate_reviews r JOIN leads l ON l.id=r.existing_lead_id JOIN users u ON u.id=r.requested_by LEFT JOIN users d ON d.id=r.decided_by
     WHERE r.status=? ORDER BY r.id`, [status]);
}

export async function decideReview(actor: Actor, id: number, input: Record<string, unknown>) {
  if (!can(actor, "approvals.decide") && !isManager(actor)) throw new HttpError(403, "Only Chief or the Owner can review possible duplicates.");
  const d = parse(z.object({ decision: z.enum(["same", "different"]), note: optText(500).optional() }), input);
  const r = await run("UPDATE duplicate_reviews SET status=?, decided_by=?, decided_at=?, note=COALESCE(?,note) WHERE id=? AND status='pending'", [d.decision, actor.id, now(), d.note ?? null, id]);
  if (!r.changes) throw new HttpError(409, "That review does not exist or was already decided.");
  await audit(actor, "decide_duplicate_review", "duplicate_review", id, d);
}
