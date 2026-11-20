import { z } from "zod";
import type { InValue } from "@libsql/client";
import { all, one, run, now, tx, localMidnight, addDays, todayYmd, type Row } from "../db";
import { HttpError, can, requirePerm, isManager, type Actor } from "../auth";
import { liveTasks } from "./taskview";
import { audit, parse, optText, reqText, optDate, optBool, domainOf, assertListKey, optInt, parseEventDate, eventDateText, dateProblem, type EventDate } from "./common";

/* ---------- access ---------- */
export function leadScope(actor: Actor, alias = "l"): { sql: string; args: InValue[] } {
  if (can(actor, "leads.view_all")) return { sql: "1=1", args: [] };
  return {
    sql: `(${alias}.owner_id = ? OR EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=${alias}.id AND t.assignee_id=?))`,
    args: [actor.id, actor.id],
  };
}

export async function assertLeadAccess(actor: Actor, leadId: number): Promise<Row> {
  const s = leadScope(actor);
  const lead = await one(`SELECT l.* FROM leads l WHERE l.id=? AND ${s.sql}`, [leadId, ...s.args]);
  if (!lead) throw new HttpError(404, "Lead not found (or not assigned to you).");
  return lead;
}

/* ---------- duplicates ---------- */
export async function findDuplicates(q: { company?: string | null; website?: string | null; emails?: string[] }, excludeId?: number) {
  const out = new Map<number, { id: number; company: string; owner: string | null; stage: string; reason: string }>();
  const ex = excludeId ?? -1;
  const base = `SELECT l.id,l.company,l.stage,u.name AS owner FROM leads l LEFT JOIN users u ON u.id=l.owner_id`;
  const domain = domainOf(q.website);
  if (domain) for (const r of await all(`${base} WHERE l.domain=? AND l.id<>? AND l.is_demo=0`, [domain, ex])) out.set(r.id, { ...(r as { id: number; company: string; owner: string | null; stage: string }), reason: `same website (${domain})` });
  if (q.company?.trim())
    for (const r of await all(`${base} WHERE lower(l.company)=lower(?) AND l.id<>? AND l.is_demo=0`, [q.company.trim(), ex]))
      if (!out.has(r.id)) out.set(r.id, { ...(r as { id: number; company: string; owner: string | null; stage: string }), reason: "same company name" });
  for (const e of (q.emails ?? []).filter(Boolean)) {
    for (const r of await all(
      `${base} JOIN contacts c ON c.lead_id=l.id WHERE lower(c.email)=lower(?) AND l.id<>? AND l.is_demo=0`,
      [e.trim(), ex],
    ))
      if (!out.has(r.id)) out.set(r.id, { ...(r as { id: number; company: string; owner: string | null; stage: string }), reason: `same contact email (${e})` });
  }
  return [...out.values()];
}

/* ---------- schemas ---------- */
const contactSchema = z.object({
  name: reqText(120),
  role: optText(120),
  source_url: optText(600),
  language: optText(40),
  email: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : null), z.string().email("invalid email").nullable()),
  phone: optText(60),
  linkedin: optText(300),
  other_social: optText(500),
  notes: optText(1000),
});

const leadFields = {
  company: reqText(200),
  website: optText(300),
  industry: optText(80),
  country: optText(80),
  market: optText(80),
  segment: optText(80),
  language: optText(40),
  source: optText(80),
  source_url: optText(500),
  owner_id: optInt,
  service: optText(120),
  notes: optText(8000),
  next_action: optText(300),
  next_due_at: optDate,
};
const createSchema = z.object({
  ...leadFields,
  stage: z.string().optional(),
  contacts: z.array(contactSchema).optional(),
  allow_duplicate: optBool.optional(),
  campaign_id: optInt.optional(),
  is_test: optBool.optional(),
  lead_date: z.unknown().optional(),
  /** Who really found the lead: an employee id, or "unknown". Stored as the discovery credit; the person entering it stays the registrar (imported_by). */
  original_researcher: z.union([z.coerce.number().int(), z.literal("unknown")]).optional(),
});

/** Extra, internal options for imports (never taken from user input). */
export type CreateOpts = {
  /** A lead with no lead_date is "unknown" (imports) instead of "found today" (hand-entered). */
  unknownDateByDefault?: boolean;
  /** The person who really found the lead (reports credit them); the actor stays the importer. */
  originalEmployeeId?: number | null;
  externalId?: string | null;
  batchId?: number | null;
};

function leadDateFrom(v: unknown, fallbackNow: string, unknownByDefault: boolean): EventDate {
  const blank = v == null || (typeof v === "string" && v.trim() === "");
  if (blank) return unknownByDefault ? { at: null, precision: "unknown" } : { at: fallbackNow, precision: "time" };
  const e = parseEventDate(v);
  if (typeof e === "string") throw new HttpError(400, dateProblem(e, "lead_date"));
  if (e.at && new Date(e.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, "lead_date: cannot be in the future.");
  return e;
}

async function checkLists(d: { industry?: string | null; market?: string | null; segment?: string | null; language?: string | null; source?: string | null; service?: string | null; stage?: string }) {
  await assertListKey("industry", d.industry, "industry");
  await assertListKey("market", d.market, "market");
  await assertListKey("segment", d.segment, "segment");
  await assertListKey("language", d.language, "language");
  await assertListKey("source", d.source, "source");
  await assertListKey("service", d.service, "service");
  if (d.stage) await assertListKey("stage", d.stage, "stage");
}

async function assertAssignable(ownerId: number | null | undefined) {
  if (!ownerId) return;
  const u = await one("SELECT id FROM users WHERE id=? AND active=1", [ownerId]);
  if (!u) throw new HttpError(400, "owner_id: that employee does not exist or is disabled.");
}

/* ---------- create / update ---------- */
export async function createLead(actor: Actor, input: unknown, isDemo = false, opts: CreateOpts = {}) {
  requirePerm(actor, "leads.create");
  const d = parse(createSchema, input);
  await checkLists(d);
  let ownerId = d.owner_id ?? null;
  if (ownerId && ownerId !== actor.id) requirePerm(actor, "tasks.assign");
  if (!ownerId && !isManager(actor)) ownerId = actor.id;
  if (!isDemo) await assertAssignable(ownerId);

  let campaignId: number | null = null;
  if (d.campaign_id) {
    const camp = await one("SELECT id,status,name FROM campaigns WHERE id=?", [d.campaign_id]);
    if (!camp) throw new HttpError(400, "campaign_id: unknown campaign.");
    if (camp.status === "closed") throw new HttpError(400, `campaign_id: "${camp.name}" is closed.`);
    campaignId = camp.id as number;
  }
  const isTest = isDemo || !!d.is_test; // test records are labelled and never counted in reports
  if (!isDemo && !isTest && !d.allow_duplicate) {
    const dups = await findDuplicates({ company: d.company, website: d.website, emails: d.contacts?.map((c) => c.email ?? "") });
    if (dups.length) {
      const e = new HttpError(409, `Possible duplicate: ${dups.map((x) => `${x.company} (#${x.id}, ${x.reason})`).join("; ")}. Resend with allow_duplicate=true if this is a different lead.`);
      (e as HttpError & { duplicates?: unknown }).duplicates = dups;
      throw e;
    }
  }
  const stage = d.stage || ((await one("SELECT key FROM lists WHERE kind='stage' AND active=1 ORDER BY position,id LIMIT 1"))!.key as string);
  const t = now();
  const ld = leadDateFrom(d.lead_date, t, !!opts.unknownDateByDefault);
  let original: number | null = opts.originalEmployeeId ?? actor.id;
  if (d.original_researcher !== undefined) {
    if (d.original_researcher === "unknown") original = null;
    else {
      if (d.original_researcher !== actor.id) requirePerm(actor, "tasks.assign");
      if (!isDemo && !(await one("SELECT id FROM users WHERE id=?", [d.original_researcher]))) throw new HttpError(400, "original_researcher: unknown employee id (or use \"unknown\").");
      original = d.original_researcher;
    }
  }
  const imported = original !== actor.id || opts.batchId || opts.unknownDateByDefault ? actor.id : null;
  const r = await run(
    `INSERT INTO leads (company,website,domain,industry,country,market,segment,language,source,source_url,owner_id,stage,service,notes,next_action,next_due_at,is_demo,created_by,created_at,updated_at,
                        lead_date,lead_date_precision,external_id,imported_by,import_batch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.company, d.website, domainOf(d.website), d.industry, d.country, d.market, d.segment, d.language, d.source, d.source_url, ownerId, stage, d.service, d.notes,
      d.next_action, d.next_due_at, isTest ? 1 : 0, original, t, t,
      ld.at, ld.precision === "unknown" ? null : ld.precision, opts.externalId ?? null, imported, opts.batchId ?? null],
  );
  for (const [i, c] of (d.contacts ?? []).entries()) {
    await run(
      `INSERT INTO contacts (lead_id,name,role,email,phone,linkedin,other_social,notes,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, c.name, c.role, c.email, c.phone, c.linkedin, c.other_social, c.notes, i === 0 ? 1 : 0, t, t],
    );
  }
  if (campaignId)
    await run("INSERT INTO lead_campaigns (lead_id,campaign_id,status,is_original,added_by,joined_at) VALUES (?,?,'active',1,?,?)", [r.id, campaignId, actor.id, t]);
  await audit(actor, "create_lead", "lead", r.id, { company: d.company, ...(campaignId ? { campaign_id: campaignId } : {}), owner_id: ownerId, ...(isTest ? { test: true } : {}), ...(ld.at ? { lead_date: ld.at, precision: ld.precision } : { lead_date: "unknown" }) });
  return r.id;
}

const updateSchema = z.object(Object.fromEntries(Object.entries(leadFields).map(([k, v]) => [k, (v as z.ZodType).optional()]))) as z.ZodType<Record<string, unknown>>;

export async function updateLead(actor: Actor, leadId: number, input: Record<string, unknown>) {
  requirePerm(actor, "leads.edit");
  const lead = await assertLeadAccess(actor, leadId);
  // Only fields actually present are changed.
  const present = Object.keys(input).filter((k) => k in leadFields);
  const d = parse(updateSchema, Object.fromEntries(present.map((k) => [k, input[k]])));
  let dateChange: EventDate | null = null;
  if ("lead_date" in input) {
    const e = parseEventDate(input.lead_date);
    if (typeof e === "string") throw new HttpError(400, dateProblem(e, "lead_date"));
    if (e.at && new Date(e.at).getTime() > Date.now() + 5 * 60000) throw new HttpError(400, "lead_date: cannot be in the future.");
    dateChange = e;
    // A date-only value that equals the day we already hold (e.g. an edit form that was not touched) keeps the exact time.
    if (e.precision === "day" && lead.lead_date && lead.lead_date_precision === "time" && eventDateText(lead.lead_date, "day") === eventDateText(e.at, "day")) dateChange = null;
  }
  if ("company" in d && !d.company) throw new HttpError(400, "company: required");
  await checkLists(Object.fromEntries(present.filter((k) => d[k] !== lead[k]).map((k) => [k, d[k]])) as never);
  if ("owner_id" in d && d.owner_id !== lead.owner_id) {
    requirePerm(actor, "tasks.assign");
    await assertAssignable(d.owner_id as number | null);
  }
  const sets: string[] = [];
  const args: InValue[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of present) {
    if (d[k] === lead[k]) continue;
    sets.push(`${k}=?`);
    args.push(d[k] as InValue);
    changes[k] = { from: lead[k], to: d[k] };
    if (k === "website") {
      sets.push("domain=?");
      args.push(domainOf(d.website as string | null));
    }
  }
  if (dateChange && (dateChange.at !== lead.lead_date || (dateChange.precision === "unknown" ? null : dateChange.precision) !== lead.lead_date_precision)) {
    sets.push("lead_date=?", "lead_date_precision=?");
    args.push(dateChange.at, dateChange.precision === "unknown" ? null : dateChange.precision);
    changes.lead_date = { from: lead.lead_date ? { at: lead.lead_date, precision: lead.lead_date_precision } : "unknown", to: dateChange.at ? { at: dateChange.at, precision: dateChange.precision } : "unknown" };
  }
  if (!sets.length) return;
  await run(`UPDATE leads SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...args, now(), leadId]);
  await audit(actor, "update_lead", "lead", leadId, changes);
}

/* ---------- test data flag ---------- */
/**
 * Mark a lead (and everything recorded on it: tasks, history, approvals) as test data, or back to real.
 * Test records stay visible and labelled, but are never counted in the dashboard or reports. Owner/Chief only.
 */
export async function setLeadTest(actor: Actor, leadId: number, isTest: boolean) {
  if (!isManager(actor)) throw new HttpError(403, "Only the owner or Chief can mark records as test data.");
  const lead = await one("SELECT * FROM leads WHERE id=?", [leadId]);
  if (!lead) throw new HttpError(404, "Lead not found.");
  const v = isTest ? 1 : 0;
  if (lead.is_demo === v) return;
  await tx([
    { sql: "UPDATE leads SET is_demo=?, updated_at=? WHERE id=?", args: [v, now(), leadId] },
    { sql: "UPDATE tasks SET is_demo=? WHERE lead_id=?", args: [v, leadId] },
    { sql: "UPDATE activities SET is_demo=? WHERE lead_id=?", args: [v, leadId] },
    { sql: "UPDATE approvals SET is_demo=? WHERE lead_id=?", args: [v, leadId] },
  ]);
  await audit(actor, isTest ? "mark_lead_test" : "mark_lead_real", "lead", leadId, { company: lead.company });
}

/* ---------- historical-only (suppressed) entities ---------- */
export async function setLeadHistorical(actor: Actor, leadId: number, on: boolean) {
  if (!isManager(actor)) throw new HttpError(403, "Only the Owner or Chief can mark a lead historical-only.");
  const lead = await one("SELECT * FROM leads WHERE id=?", [leadId]);
  if (!lead) throw new HttpError(404, "Lead not found.");
  if (!!lead.historical_only === on) return;
  await run("UPDATE leads SET historical_only=?, updated_at=? WHERE id=?", [on ? 1 : 0, now(), leadId]);
  await audit(actor, on ? "mark_lead_historical_only" : "unmark_lead_historical_only", "lead", leadId, { company: lead.company });
}

/* ---------- stage ---------- */
export async function setStage(actor: Actor, leadId: number, stage: string, reason: string) {
  requirePerm(actor, "leads.stage");
  const lead = await assertLeadAccess(actor, leadId);
  reason = (reason ?? "").trim();
  if (reason.length < 3) throw new HttpError(400, "reason: a short explanation of what actually happened is required.");
  await assertListKey("stage", stage, "stage");
  if (stage === lead.stage) throw new HttpError(400, "The lead is already in that stage.");
  const t = now();
  await tx([
    { sql: "UPDATE leads SET stage=?, last_activity_at=?, updated_at=? WHERE id=?", args: [stage, t, t, leadId] },
    {
      sql: `INSERT INTO activities (lead_id,type,title,body,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [leadId, "status", "Stage changed", reason, lead.stage, stage, actor.id, t, t, lead.is_demo],
    },
  ]);
  await audit(actor, "change_stage", "lead", leadId, { from: lead.stage, to: stage, reason });
}

/* ---------- contacts ---------- */
const contactStatusOf = (c: Row) => (c.email_status === "opted_out" ? "opted_out" : c.email_status === "bounced" ? "bounced" : c.is_invalid ? "invalid" : "active");
export const withContactStatus = (rows: Row[]) => rows.map((c) => ({ ...c, status: contactStatusOf(c) }) as Row);

/** Same email anywhere in the CRM (any lead), case-insensitive. Returns what a caller may know about each match. */
async function emailMatches(actor: Actor, email: string, isDemo: number, excludeContactId?: number) {
  const rows = await all(
    `SELECT c.id AS contact_id, c.lead_id, c.email_status, c.is_invalid, l.company, l.owner_id FROM contacts c JOIN leads l ON l.id=c.lead_id
     WHERE lower(c.email)=lower(?) AND l.is_demo=? AND c.id<>?`, [email, isDemo, excludeContactId ?? 0]);
  const s = leadScope(actor);
  const visible = new Set((await all(`SELECT l.id FROM leads l WHERE ${s.sql}`, s.args)).map((r) => r.id as number));
  return rows.map((r) => {
    const open = visible.has(r.lead_id as number) || isManager(actor);
    return { contact_id: open ? r.contact_id : null, lead_id: open ? r.lead_id : null, company: open ? r.company : null, status: contactStatusOf(r), suppressed: r.email_status === "opted_out" || r.email_status === "bounced", restricted_reference: open ? null : "this email already exists on a lead you cannot see: ask a Chief" };
  });
}
function duplicateError(matches: Awaited<ReturnType<typeof emailMatches>>, email: string) {
  const sup = matches.find((m) => m.suppressed);
  const first = matches[0];
  const e = new HttpError(409, sup
    ? `Suppressed: ${email} is already in the CRM as ${sup.status === "opted_out" ? "opted out (do not contact)" : "bounced"}${sup.contact_id ? ` (contact #${sup.contact_id}, lead #${sup.lead_id})` : ""}. Nothing was created.`
    : `Duplicate: ${email} already exists${first.contact_id ? ` as contact #${first.contact_id} on lead #${first.lead_id}` : " on a lead you cannot see"}. Nothing was created.`);
  (e as HttpError & { duplicates?: unknown }).duplicates = matches;
  return e;
}

/** Add a contact to an existing lead: global email dedupe and suppression check first. Never creates a duplicate. */
export async function addContactDetailed(actor: Actor, leadId: number, input: unknown) {
  if (!(isManager(actor) || can(actor, "leads.edit") || can(actor, "activity.record"))) throw new HttpError(403, "You are not allowed to add contacts.");
  const lead = await assertLeadAccess(actor, leadId);
  const c = parse(contactSchema.extend({ name: optText(120) }), input);
  if (!c.name && !c.email && !c.phone && !c.linkedin) throw new HttpError(400, "Give at least a name, email, phone or LinkedIn.");
  const warnings: string[] = [];
  if (c.email) {
    const m = await emailMatches(actor, c.email, lead.is_demo as number);
    if (m.length) throw duplicateError(m, c.email);
  }
  if (Number((await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=? AND email_status='opted_out'", [leadId]))!.n) > 0) warnings.push("This lead already has an opted-out contact (do not contact): sends to it stay blocked.");
  const t = now();
  const n = Number((await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=?", [leadId]))!.n);
  const name = c.name || "(no name)";
  const r = await run(
    `INSERT INTO contacts (lead_id,name,role,email,phone,linkedin,other_social,notes,source_url,language,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [leadId, name, c.role, c.email, c.phone, c.linkedin, c.other_social, c.notes, c.source_url, c.language, n === 0 ? 1 : 0, t, t],
  );
  await run("INSERT INTO activities (lead_id,contact_id,type,title,body,actor_id,occurred_at,created_at,is_demo) VALUES (?,?,'note',?,?,?,?,?,?)",
    [leadId, r.id, `Contact added: ${c.name || c.email || c.phone}`, `Added by ${actor.name} (${actor.via}).${c.email ? ` Email ${c.email}.` : ""}`, actor.id, t, t, lead.is_demo as number]);
  await audit(actor, "add_contact", "contact", r.id, { lead_id: leadId, name });
  return { id: r.id, lead_id: leadId, status: "active", warnings };
}
export async function addContact(actor: Actor, leadId: number, input: unknown) {
  return (await addContactDetailed(actor, leadId, input)).id;
}

const CONTACT_STATUSES = ["active", "invalid", "bounced", "opted_out"] as const;
const contactUpdate = contactSchema.partial().extend({ email_status: z.enum(["unknown", "ok", "bounced", "opted_out"]).optional(), status: z.enum(CONTACT_STATUSES).optional() });
export async function updateContact(actor: Actor, contactId: number, input: Record<string, unknown>) {
  if (!(isManager(actor) || can(actor, "leads.edit"))) throw new HttpError(403, "You are not allowed to edit contacts.");
  const c0 = await one("SELECT * FROM contacts WHERE id=?", [contactId]);
  if (!c0) throw new HttpError(404, "Contact not found.");
  const lead = await assertLeadAccess(actor, c0.lead_id as number);
  const keys = Object.keys(input).filter((k) => ["name", "role", "email", "phone", "linkedin", "other_social", "notes", "email_status", "source_url", "language", "status"].includes(k));
  const d = parse(contactUpdate, Object.fromEntries(keys.map((k) => [k, input[k]]))) as Record<string, unknown>;
  const sets: string[] = [];
  const args: InValue[] = [];
  const changes: Record<string, unknown> = {};
  const setCol = (col: string, val: InValue) => { if (c0[col] === val) return; sets.push(`${col}=?`); args.push(val); changes[col] = { from: c0[col], to: val }; };
  for (const k of keys) {
    if (k === "status") continue;
    if (d[k] === c0[k]) continue;
    if (k === "name" && !d[k]) throw new HttpError(400, "name: required");
    if (k === "email" && d.email) {
      const m = await emailMatches(actor, d.email as string, lead.is_demo as number, contactId);
      if (m.length) throw duplicateError(m, d.email as string);
    }
    // Suppression is permanent unless an Owner/Chief explicitly corrects it (audited below).
    if (k === "email_status" && (c0.email_status === "opted_out" || c0.email_status === "bounced") && d[k] !== "opted_out" && !(c0.email_status === "bounced" && d[k] === "opted_out") && !isManager(actor))
      throw new HttpError(403, `This contact is marked ${c0.email_status}. Only the Owner or Chief can correct that.`);
    setCol(k, d[k] as InValue);
  }
  if (d.status) {
    // Contacts are never deleted: their status says what they are.
    const suppressed = c0.email_status === "opted_out" || c0.email_status === "bounced";
    if (d.status === "opted_out" || d.status === "bounced") setCol("email_status", d.status);
    else if (d.status === "invalid") setCol("is_invalid", 1);
    else {
      if (suppressed && !isManager(actor)) throw new HttpError(403, `This contact is marked ${c0.email_status}. Only the Owner or Chief can reactivate it.`);
      setCol("is_invalid", 0);
      if (suppressed) setCol("email_status", "ok");
    }
  }
  if (!sets.length) return;
  await run(`UPDATE contacts SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...args, now(), contactId]);
  await audit(actor, "update_contact", "contact", contactId, changes);
}

export async function getContact(actor: Actor, contactId: number) {
  const c = await one("SELECT * FROM contacts WHERE id=?", [contactId]);
  if (!c) throw new HttpError(404, "Contact not found.");
  await assertLeadAccess(actor, c.lead_id as number);
  return withContactStatus([c])[0];
}

/* ---------- "needs attention" filters ---------- */
/**
 * ONE definition each, shared by the dashboard counters, the dashboard lists and the Leads page filter,
 * so a number on the dashboard always opens exactly the leads it counted.
 */
export { ATTENTION, type Attention } from "../constants";
import { ATTENTION, STEP_LONG, type Attention } from "../constants";
import { parseSort } from "../sort";
import { displayType } from "./tasklist";
import { leadSequenceInfo, type LeadSeq } from "./sequences";
import { fmtYmd, toLocalInput } from "../format";
type SqlPart = { sql: string; args: InValue[] };

/** A real lead whose latest reply (last `days` days) is newer than our latest message, still open and not opted out. */
export function unansweredReplyFilter(alias = "l", days = 30): SqlPart & { replyAt: string } {
  const replyAt = `(SELECT MAX(r.occurred_at) FROM activities r WHERE r.lead_id=${alias}.id AND r.type='reply' AND r.is_demo=0 AND r.occurred_precision<>'unknown')`;
  return {
    replyAt,
    sql: `${alias}.is_demo=0 AND ${alias}.historical_only=0 AND ${replyAt}>=?
      AND NOT EXISTS (SELECT 1 FROM activities m WHERE m.lead_id=${alias}.id AND m.type='message' AND m.occurred_at>${replyAt})
      AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=${alias}.stage AND s.flag IN ('won','lost','closed','meeting'))
      AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=${alias}.id AND c.email_status='opted_out')`,
    args: [new Date(Date.now() - days * 86400000).toISOString()],
  };
}

/** A real, open lead with no open task and no activity for `days` days, that can still be contacted. */
export function quietLeadFilter(alias = "l", days = 7): SqlPart {
  return {
    sql: `${alias}.is_demo=0 AND ${alias}.historical_only=0 AND COALESCE(${alias}.last_activity_at,${alias}.created_at)<?
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=${alias}.id AND t.status IN ('todo','in_progress','changes_requested','approved','waiting_approval'))
      AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=${alias}.stage AND s.flag IN ('won','lost','closed'))
      AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=${alias}.id AND c.email_status IN ('opted_out','bounced')
        AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE c2.lead_id=${alias}.id AND c2.email_status NOT IN ('opted_out','bounced')))`,
    args: [new Date(Date.now() - days * 86400000).toISOString()],
  };
}

/** Interested or Replied, still contactable, and nothing open: the leads that have gone quiet after a reply. */
export function warmIdleFilter(alias = "l"): SqlPart {
  return {
    sql: `${alias}.is_demo=0 AND ${alias}.historical_only=0 AND (${alias}.stage IN ('replied','interested') OR EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=${alias}.stage AND s.flag='replied'))
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=${alias}.id AND t.status NOT IN ('completed','cancelled'))
      AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=${alias}.id AND c.email_status='opted_out')`,
    args: [],
  };
}

/* ---------- reads ---------- */
export const OUTREACH = ["not_contacted", "no_reply", "replied", "bounced", "opted_out"] as const;
export type Outreach = (typeof OUTREACH)[number];
export const TASK_FILTER = ["open", "overdue", "none"] as const;
export const ACTIVE_FILTER = ["7", "30", "90", "stale30", "stale90"] as const;
export const CONTACT_FILTER = ["has_email", "no_email"] as const;
export const NEXT_STEP_FILTER = ["due_today", "overdue", "due_week", "missing"] as const;
export const SEQ_STATUS_FILTER = ["running", "paused", "stopped_reply", "stopped_bounce", "stopped", "completed", "resting", "none"] as const;
export const LEAD_SORTS = ["company", "stage", "market", "country", "owner_name", "id", "created_at", "updated_at", "lead_date", "last_activity_at", "next_due", "first_email_sent_at", "last_email_sent_at", "emails_sent", "source", "campaign"] as const;
const LEAD_SORT_ALIASES: Record<string, string> = { oldest: "last_activity_at", due: "next_due", "-due": "-next_due", next_due_at: "next_due", "-next_due_at": "-next_due", added: "-lead_date", newest: "-lead_date", owner: "owner_name", "-owner": "-owner_name", last_activity: "last_activity_at", "-last_activity": "-last_activity_at", name: "company", "-name": "-company" };
export type LeadFilters = {
  q?: string; owner?: number | "none"; market?: string; segment?: string; stage?: string; channel?: string; testOnly?: boolean;
  includeDemo?: boolean; includeHistorical?: boolean; page?: number; pageSize?: number; sort?: string;
  /** Leads that are an active member of this campaign ("none" = in no campaign). */
  campaign?: number | "none";
  /** Only leads that need attention (same rules as the dashboard). */
  attention?: Attention;
  industry?: string; source?: string; service?: string; language?: string; country?: string;
  /** Where outreach stands: never emailed, emailed with no reply, replied, a bounce, an opt-out. */
  outreach?: Outreach;
  /** Open work on the lead: has an open task, has a late one, or has none. */
  task?: (typeof TASK_FILTER)[number];
  /** Lead date (or the day it entered the CRM), YYYY-MM-DD. */
  addedFrom?: string; addedTo?: string;
  /** Activity in the last 7 / 30 / 90 days, or none for 30+ / 90+ days. */
  active?: (typeof ACTIVE_FILTER)[number];
  contact?: (typeof CONTACT_FILTER)[number];
  /** The lead's next step: due today, overdue, due this week, or missing altogether. */
  nextStep?: (typeof NEXT_STEP_FILTER)[number];
  sequenceStatus?: (typeof SEQ_STATUS_FILTER)[number];
  /** The last sequence step that was sent: E1, FU1, FU2 ... */
  sequenceStep?: string;
  sender?: number;
  /** Experiment label, whole ("MI-A") or by prefix ("MI"). */
  label?: string;
  /** Filter values that were not understood (reported back instead of being ignored silently). */
  warnings?: string[];
};

const oneOf = <T extends readonly string[]>(list: T, v: string | null | undefined): T[number] | undefined => (v && (list as readonly string[]).includes(v) ? (v as T[number]) : undefined);
const ymdOk = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** The lead filters as they arrive in a URL (the Leads page, the CSV export and the API all read them the same way). */
export function leadFiltersFrom(get: (key: string) => string | null | undefined): LeadFilters {
  const str = (k: string) => get(k)?.trim() || undefined;
  const warnings: string[] = [];
  const oneOf = <T extends readonly string[]>(list: T, v: string | null | undefined, k = ""): T[number] | undefined => {
    if (v && !(list as readonly string[]).includes(v)) warnings.push(`${k}: "${v}" is not one of ${list.join(", ")}; it was ignored.`);
    return v && (list as readonly string[]).includes(v) ? (v as T[number]) : undefined;
  };
  const ymdOk = (v: string | null | undefined, k = "") => { if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) warnings.push(`${k}: use YYYY-MM-DD; "${v}" was ignored.`); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined; };
  const id = (k: string): number | "none" | undefined => { const v = get(k); return v === "none" ? "none" : v && /^\d+$/.test(v) ? Number(v) : undefined; };
  return {
    q: str("q"), owner: id("owner"), market: str("market"), segment: str("segment"), stage: str("stage"), channel: str("channel"), sort: str("sort"),
    campaign: id("campaign") ?? id("campaign_id"), attention: oneOf(ATTENTION, get("attention"), "attention"),
    industry: str("industry"), source: str("source"), service: str("service"), language: str("language"), country: str("country"),
    outreach: oneOf(OUTREACH, get("outreach"), "outreach"), task: oneOf(TASK_FILTER, get("task"), "task"), active: oneOf(ACTIVE_FILTER, get("active"), "active"), contact: oneOf(CONTACT_FILTER, get("contact"), "contact"),
    addedFrom: ymdOk(get("added_from"), "added_from"), addedTo: ymdOk(get("added_to"), "added_to"),
    nextStep: oneOf(NEXT_STEP_FILTER, get("next_step"), "next_step"), sequenceStatus: oneOf(SEQ_STATUS_FILTER, get("sequence_status"), "sequence_status"),
    sequenceStep: str("sequence_step")?.toUpperCase(), sender: typeof id("sender") === "number" ? (id("sender") as number) : undefined, label: str("label"), warnings,
  };
}

const OPEN_TASK = "t.status NOT IN ('completed','cancelled')";
const SENT = (extra = "") => `EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.type='message'${extra})`;
const REPLIED = "EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.type='reply')";

function leadWhere(actor: Actor, f: LeadFilters, skip: { stage?: boolean } = {}) {
  const s = leadScope(actor);
  const where = [s.sql];
  const args: InValue[] = [...s.args];
  const eq = (col: string, v: string | number | undefined) => { if (v !== undefined && v !== "") { where.push(`${col}=?`); args.push(v); } };
  if (!f.includeDemo) where.push("l.is_demo=0");
  if (f.testOnly) where.push("l.is_demo=1");
  // Historical-only entities are listed by default (they are real records); pass includeHistorical:false to hide them (e.g. task pickers).
  if (f.includeHistorical === false) where.push("l.historical_only=0");
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase()}%`;
    where.push(`(lower(l.company) LIKE ? OR l.domain LIKE ? OR lower(l.country) LIKE ? OR EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND (lower(c.name) LIKE ? OR lower(c.email) LIKE ?)))`);
    args.push(like, like, like, like, like);
  }
  if (f.owner === "none") where.push("l.owner_id IS NULL"); else eq("l.owner_id", f.owner);
  eq("l.market", f.market); eq("l.segment", f.segment); eq("l.industry", f.industry); eq("l.source", f.source); eq("l.service", f.service); eq("l.language", f.language);
  if (!skip.stage) eq("l.stage", f.stage);
  if (f.country?.trim()) (where.push("lower(l.country) LIKE ?"), args.push(`%${f.country.trim().toLowerCase()}%`));
  if (f.channel) (where.push("EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.channel=?)"), args.push(f.channel));
  if (f.campaign === "none") where.push("NOT EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.status='active')");
  else if (f.campaign) (where.push("EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.campaign_id=? AND lc.status='active')"), args.push(f.campaign));
  if (f.attention) {
    const a = f.attention === "unanswered" ? unansweredReplyFilter() : f.attention === "warm_idle" ? warmIdleFilter() : quietLeadFilter();
    where.push(`(${a.sql})`);
    args.push(...a.args);
  }
  if (f.outreach === "not_contacted") where.push(`NOT ${SENT()}`);
  // Contacted and still waiting: no reply, and still contactable (not opted out, not suppressed, not historical-only, at least one address that did not bounce).
  if (f.outreach === "no_reply") where.push(`${SENT()} AND NOT ${REPLIED} AND l.historical_only=0
    AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')
    AND NOT (EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id) AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status<>'bounced'))
    AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.kind IN ('dnc','opt_out') AND ((sp.scope='domain' AND sp.value=l.domain) OR (sp.scope='email' AND sp.value IN (SELECT lower(c.email) FROM contacts c WHERE c.lead_id=l.id))))`);
  if (f.outreach === "replied") where.push(REPLIED);
  if (f.outreach === "bounced") where.push("(EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.outcome='bounced') OR EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='bounced'))");
  if (f.outreach === "opted_out") where.push("EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')");
  if (f.task === "open") where.push(`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK})`);
  if (f.task === "none") where.push(`NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK})`);
  if (f.task === "overdue") (where.push(`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK} AND COALESCE(t.scheduled_at,t.due_at)<?)`), args.push(now()));
  if (f.addedFrom) (where.push("substr(COALESCE(l.lead_date,l.created_at),1,10)>=?"), args.push(f.addedFrom));
  if (f.addedTo) (where.push("substr(COALESCE(l.lead_date,l.created_at),1,10)<=?"), args.push(f.addedTo));
  if (f.active) {
    const stale = f.active.startsWith("stale");
    const cut = new Date(Date.now() - Number(f.active.replace("stale", "")) * 86400000).toISOString();
    where.push(`COALESCE(l.last_activity_at,l.created_at)${stale ? "<" : ">="}?`);
    args.push(cut);
  }
  const NEXT_AT = `(SELECT MIN(COALESCE(t.scheduled_at,t.due_at)) FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK})`;
  if (f.nextStep === "overdue") (where.push(`${NEXT_AT}<?`), args.push(now()));
  if (f.nextStep === "due_today") (where.push(`${NEXT_AT}>=? AND ${NEXT_AT}<?`), args.push(localMidnight(todayYmd()).toISOString(), localMidnight(addDays(todayYmd(), 1)).toISOString()));
  if (f.nextStep === "due_week") { let d = todayYmd(); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) d = addDays(d, 1); where.push(`${NEXT_AT}<?`); args.push(localMidnight(addDays(d, 1)).toISOString()); }
  // An active, contacted lead with nothing planned: no open task and no sequence that is resting or paused.
  if (f.nextStep === "missing") where.push(`l.historical_only=0 AND ${SENT()} AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK})
    AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.status IN ('resting','paused'))
    AND NOT EXISTS (SELECT 1 FROM lists s WHERE s.kind='stage' AND s.key=l.stage AND s.flag IN ('won','lost','closed'))
    AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email_status='opted_out')`);
  if (f.sequenceStatus === "none") where.push("NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id)");
  else if (f.sequenceStatus === "stopped_reply") where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.status='stopped' AND e.stop_reason LIKE 'reply%')");
  else if (f.sequenceStatus === "stopped_bounce") where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.status='stopped' AND (e.stop_reason LIKE '%bounce%' OR e.stop_reason LIKE '%opt%'))");
  else if (f.sequenceStatus) (where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.status=?)"), args.push(f.sequenceStatus));
  if (f.sequenceStep) (where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.last_step_code=?)"), args.push(f.sequenceStep));
  if (f.sender) (where.push("(EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.sender_id=?) OR EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent' AND COALESCE(a.sender_id,1)=?))"), args.push(f.sender, f.sender));
  if (f.label) (where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND e.labels LIKE ?)"), args.push(`%"${f.label.replace(/[%_"]/g, "")}%`));
  if (f.contact === "has_email") where.push("EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email IS NOT NULL AND c.email<>'')");
  if (f.contact === "no_email") where.push("NOT EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND c.email IS NOT NULL AND c.email<>'')");
  return { W: where.join(" AND "), args };
}

export async function listLeads(actor: Actor, f: LeadFilters) {
  const { W, args } = leadWhere(actor, f);
  const size = f.pageSize ?? 50;
  const page = Math.max(1, f.page ?? 1);
  const MAILS = (fn: string) => `(SELECT ${fn} FROM activities a WHERE a.lead_id=l.id AND a.type='message' AND a.outcome='sent' AND COALESCE(a.channel,'email')='email' AND a.occurred_precision<>'unknown')`;
  const EXPR: Record<(typeof LEAD_SORTS)[number], string> = {
    company: "lower(l.company)", stage: "l.stage", market: "l.market", country: "lower(l.country)", owner_name: "lower(u.name)", id: "l.id", created_at: "l.created_at", updated_at: "l.updated_at",
    lead_date: "COALESCE(l.lead_date,l.created_at)", last_activity_at: "COALESCE(l.last_activity_at,l.created_at)", source: "l.source",
    next_due: `(SELECT MIN(COALESCE(t.scheduled_at,t.due_at)) FROM tasks t WHERE t.lead_id=l.id AND ${OPEN_TASK})`,
    first_email_sent_at: MAILS("MIN(a.occurred_at)"), last_email_sent_at: MAILS("MAX(a.occurred_at)"), emails_sent: MAILS("COUNT(*)"),
    campaign: "(SELECT lower(c.name) FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.lead_id=l.id AND lc.status='active' ORDER BY lc.id LIMIT 1)",
  };
  const sort = parseSort(f.sort, LEAD_SORTS, LEAD_SORT_ALIASES, "-last_activity_at");
  const ex = EXPR[sort.field as (typeof LEAD_SORTS)[number]];
  // empty values last in both directions
  const order = `(${ex} IS NULL OR ${ex}=''), ${ex} ${sort.desc ? "DESC" : "ASC"}`;
  const warnings = [...(f.warnings ?? []), ...(sort.warning ? [sort.warning] : [])];
  const [totalRow, rows] = await Promise.all([one(`SELECT COUNT(*) AS n FROM leads l WHERE ${W}`, args), all(
    `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
     WHERE ${W} ORDER BY ${order}, l.id DESC LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size],
  )]);
  const total = Number(totalRow!.n);
  // page_size / has_more are the names every paged list uses; pageSize is kept for older clients.
  return { rows, total, page, pageSize: size, page_size: size, has_more: page * size < total, applied_sort: sort.applied, warnings };
}

/** How many leads each stage holds under the current filters (the stage filter itself is left out, so the strip works as a switch). */
export async function leadStageCounts(actor: Actor, f: LeadFilters) {
  const { W, args } = leadWhere(actor, f, { stage: true });
  const rows = await all(`SELECT l.stage, COUNT(*) AS n FROM leads l WHERE ${W} GROUP BY l.stage`, args);
  return new Map(rows.map((r) => [r.stage as string, Number(r.n)]));
}

export type LeadOutreach = { sent: number; replies: number; lastSentAt: string | null; lastReplyAt: string | null; bounced: boolean; lastType: string | null; lastKind: string | null; lastTitle: string | null };
export type LeadContactSummary = { name: string; role: string | null; email: string | null; status: string; count: number; optedOut: boolean; bounced: boolean };

/**
 * For a page of the leads list: each lead's active campaign(s), its next open task with the LIVE status (same code as everywhere else),
 * its main contact, and where outreach stands (messages sent, replies, bounces, the latest thing that happened).
 */
export async function leadListExtras(leadIds: number[]) {
  const campaigns = new Map<number, { id: number; name: string }[]>();
  const nextTask = new Map<number, Row>();
  const contact = new Map<number, LeadContactSummary>();
  const outreach = new Map<number, LeadOutreach>();
  if (!leadIds.length) return { campaigns, nextTask, contact, outreach };
  const marks = leadIds.map(() => "?").join(",");
  const [camps, tasks, contacts, sums, lasts] = await Promise.all([
    all(`SELECT lc.lead_id,c.id,c.name FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id WHERE lc.status='active' AND lc.lead_id IN (${marks}) ORDER BY lc.joined_at`, leadIds),
    all(
      `SELECT t.id,t.title,t.status,t.lead_id,t.prep_status,t.blockers,t.scheduled_at,t.due_at,t.message_version_id,t.sent_at,t.activity_id,t.due_on,t.scheduled_on,t.hold_reason,t.rescheduled_from,
              t.step_code,t.step_number,t.step_total,t.window_end_on,t.action_type,t.task_type,t.channel,t.enrollment_id,t.is_late,t.assignee_id,
              u.name AS assignee_name, COALESCE(t.scheduled_at,t.due_at) AS sort_at
       FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.lead_id IN (${marks}) AND t.status NOT IN ('completed','cancelled')
       ORDER BY (COALESCE(t.scheduled_at,t.due_at) IS NULL), COALESCE(t.scheduled_at,t.due_at), t.id`, leadIds),
    all(`SELECT lead_id,name,role,email,email_status FROM contacts WHERE lead_id IN (${marks}) ORDER BY is_primary DESC, id`, leadIds),
    all(
      `SELECT lead_id,
         SUM(CASE WHEN type='message' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN type='reply' THEN 1 ELSE 0 END) AS replies,
         MAX(CASE WHEN type='message' AND occurred_precision<>'unknown' THEN occurred_at END) AS last_sent, MAX(CASE WHEN type='reply' AND occurred_precision<>'unknown' THEN occurred_at END) AS last_reply,
         MAX(CASE WHEN outcome='bounced' THEN 1 ELSE 0 END) AS bounced
       FROM activities WHERE lead_id IN (${marks}) GROUP BY lead_id`, leadIds),
    // the latest dated thing on each lead (SQLite returns the other columns from the MAX row)
    all(`SELECT lead_id,type,message_kind,title,MAX(occurred_at) AS at FROM activities WHERE lead_id IN (${marks}) AND occurred_precision<>'unknown' GROUP BY lead_id`, leadIds),
  ]);
  for (const c of camps) (campaigns.get(c.lead_id as number) ?? campaigns.set(c.lead_id as number, []).get(c.lead_id as number)!).push({ id: c.id as number, name: c.name as string });
  const firsts: Row[] = [];
  const seen = new Set<number>();
  for (const t of tasks) if (!seen.has(t.lead_id as number)) (seen.add(t.lead_id as number), firsts.push(t));
  for (const t of await liveTasks(firsts)) nextTask.set(t.lead_id as number, t);
  for (const c of contacts) {
    const cur = contact.get(c.lead_id as number);
    if (!cur) contact.set(c.lead_id as number, { name: c.name as string, role: (c.role as string | null) ?? null, email: (c.email as string | null) || null, status: c.email_status as string, count: 1, optedOut: c.email_status === "opted_out", bounced: c.email_status === "bounced" });
    else { cur.count++; cur.optedOut ||= c.email_status === "opted_out"; cur.bounced ||= c.email_status === "bounced"; }
  }
  const last = new Map(lasts.map((r) => [r.lead_id as number, r]));
  for (const r of sums) {
    const l = last.get(r.lead_id as number);
    outreach.set(r.lead_id as number, { sent: Number(r.sent), replies: Number(r.replies), lastSentAt: (r.last_sent as string | null) ?? null, lastReplyAt: (r.last_reply as string | null) ?? null, bounced: !!Number(r.bounced),
      lastType: (l?.type as string | null) ?? null, lastKind: (l?.message_kind as string | null) ?? null, lastTitle: (l?.title as string | null) ?? null });
  }
  return { campaigns, nextTask, contact, outreach };
}

export async function getLead(actor: Actor, id: number) {
  // The access check and every read start together (one round trip deep); nothing is returned if access is refused.
  const [, lead0, contactRows, history, taskRows] = await Promise.all([
    assertLeadAccess(actor, id),
    one(
      `SELECT l.*, u.name AS owner_name, cb.name AS created_by_name, ib.name AS imported_by_name FROM leads l
       LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN users cb ON cb.id=l.created_by LEFT JOIN users ib ON ib.id=l.imported_by WHERE l.id=?`,
      [id],
    ),
    all("SELECT * FROM contacts WHERE lead_id=? ORDER BY is_primary DESC, id", [id]),
    all(
      `SELECT a.*, COALESCE(u.name,'Unknown original employee') AS actor_name, (a.actor_id IS NULL) AS actor_unknown, COALESCE(u.is_agent,0) AS actor_is_agent, c.name AS contact_name, ib.name AS imported_by_name
       FROM activities a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN contacts c ON c.id=a.contact_id LEFT JOIN users ib ON ib.id=a.imported_by
       WHERE a.lead_id=? ORDER BY a.occurred_at DESC, a.id DESC`,
      [id],
    ),
    all(`SELECT t.*, u.name AS assignee_name, cu.name AS completed_by_name FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN users cu ON cu.id=t.completed_by WHERE t.lead_id=? ORDER BY t.created_at DESC`, [id]),
  ]);
  const lead = lead0!;
  const contacts = withContactStatus(contactRows);
  const tasks = await liveTasks(taskRows);
  return { lead, contacts, history, tasks };
}

/* ---------- the next step of a lead ---------- */
export type NextStep = { task_id: number | null; label: string; action_type: string | null; step_number: number | null; step_total: number | null; due_on: string | null; window_end_on: string | null; state: "due" | "overdue" | "planned" | "blocked" | "resting" | "none"; days_overdue: number; note: string | null; text: string };
const TYPE_LONG: Record<string, string> = { "Reply FU": "Follow-up on the reply", "Email 1": "First email", FU1: "Follow-up email 1", FU2: "Follow-up email 2", FU3: "Follow-up email 3", Reply: "Handle reply", "Email 1 draft": "First email draft", "FU draft": "Follow-up draft" };
const PREP_NOTE: Record<string, string> = { draft_needed: "draft needed", internal_review: "draft waiting for the Chief's review", user_approval_needed: "draft waiting for approval", ready_for_execution: "approved, ready to send", validation_needed: "blocked" };
/**
 * One concrete next step per lead, computed live from its open task and its sequence: never from the free-text next_action.
 * `hasSent` decides whether a lead with nothing planned is a problem ("No next step") or simply not started.
 */
export function nextStepOf(task: Row | null | undefined, seq: LeadSeq | undefined, today = todayYmd()): NextStep {
  if (task) {
    const day = (task.due_on as string | null) ?? (task.scheduled_on as string | null) ?? ((task.scheduled_at ?? task.due_at) ? toLocalInput((task.scheduled_at ?? task.due_at) as string).slice(0, 10) : null);
    const type = displayType(task);
    const label = task.step_code ? STEP_LONG[task.step_code as string] ?? type : TYPE_LONG[type] ?? (type === "Other" ? String(task.title).slice(0, 48) : type);
    const late = day && day < today ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000) : 0;
    const state: NextStep["state"] = late > 0 || task.is_overdue ? "overdue" : task.state === "blocked" && task.prep_status === "validation_needed" ? "blocked" : day === today ? "due" : "planned";
    const note = task.message_version_id || task.step_code ? PREP_NOTE[String(task.prep_status ?? "")] ?? null : null;
    const when = !day ? "no date" : day === today ? "today" : fmtYmd(day);
    return { task_id: task.id as number, label, action_type: (task.action_type as string) ?? null, step_number: (task.step_number as number) ?? null, step_total: (task.step_total as number) ?? null, due_on: day, window_end_on: (task.window_end_on as string) ?? null,
      state, days_overdue: late, note, text: `${label} · ${when}${state === "overdue" && late > 0 ? ` (overdue ${late} day${late === 1 ? "" : "s"})` : note && note !== "draft needed" ? ` (${note})` : ""}` };
  }
  const none = { task_id: null, action_type: null, step_number: null, step_total: null, window_end_on: null, days_overdue: 0, note: null };
  if (seq?.sequence_status === "resting" && seq.rest_until) return { ...none, label: "Resting", due_on: seq.rest_until, state: "resting", text: `Resting until ${fmtYmd(seq.rest_until)}` };
  if (seq?.sequence_status === "paused") return { ...none, label: "Sequence paused", due_on: null, state: "resting", text: "Sequence paused" };
  return { ...none, label: "No next step", due_on: null, state: "none", text: "No next step" };
}

/** GET /leads rows with the computed next step and the sequence facts (three extra queries for the whole page). */
export async function withNextStep(rows: Row[]) {
  const ids = rows.map((r) => r.id as number);
  const [ex, seq] = await Promise.all([leadListExtras(ids), leadSequenceInfo(ids)]);
  const today = todayYmd();
  return rows.map((r) => {
    const sq = seq.get(r.id as number);
    return { ...r, next_step: nextStepOf(ex.nextTask.get(r.id as number), sq, today), first_email_sent_at: sq?.first_email_sent_at ?? null, last_email_sent_at: sq?.last_email_sent_at ?? null, last_email_step: sq?.last_email_step ?? null,
      sequence_status: sq?.sequence_status ?? null, sequence_step: sq?.sequence_step ?? null, sequence_step_total: sq?.step_total ?? null, emails_sent_count: sq?.emails_sent_count ?? 0, experiment_labels: sq?.experiment_labels ?? [],
      campaigns: ex.campaigns.get(r.id as number) ?? [] };
  });
}
