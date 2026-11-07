import { z } from "zod";
import type { InValue } from "@libsql/client";
import { all, one, run, now, tx, type Row } from "../db";
import { HttpError, can, requirePerm, isManager, type Actor } from "../auth";
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
  is_test: optBool.optional(),
  lead_date: z.unknown().optional(),
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
  const original = opts.originalEmployeeId ?? actor.id;
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
  await audit(actor, "create_lead", "lead", r.id, { company: d.company, owner_id: ownerId, ...(isTest ? { test: true } : {}), ...(ld.at ? { lead_date: ld.at, precision: ld.precision } : { lead_date: "unknown" }) });
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
export async function addContact(actor: Actor, leadId: number, input: unknown) {
  requirePerm(actor, "leads.edit");
  await assertLeadAccess(actor, leadId);
  const c = parse(contactSchema, input);
  const t = now();
  const n = Number((await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=?", [leadId]))!.n);
  const r = await run(
    `INSERT INTO contacts (lead_id,name,role,email,phone,linkedin,other_social,notes,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [leadId, c.name, c.role, c.email, c.phone, c.linkedin, c.other_social, c.notes, n === 0 ? 1 : 0, t, t],
  );
  await audit(actor, "add_contact", "contact", r.id, { lead_id: leadId, name: c.name });
  return r.id;
}

const contactUpdate = contactSchema.partial().extend({ email_status: z.enum(["unknown", "ok", "bounced", "opted_out"]).optional() });
export async function updateContact(actor: Actor, contactId: number, input: Record<string, unknown>) {
  requirePerm(actor, "leads.edit");
  const c0 = await one("SELECT * FROM contacts WHERE id=?", [contactId]);
  if (!c0) throw new HttpError(404, "Contact not found.");
  await assertLeadAccess(actor, c0.lead_id);
  const keys = Object.keys(input).filter((k) => ["name", "role", "email", "phone", "linkedin", "other_social", "notes", "email_status"].includes(k));
  const d = parse(contactUpdate, Object.fromEntries(keys.map((k) => [k, input[k]]))) as Record<string, unknown>;
  const sets: string[] = [];
  const args: InValue[] = [];
  const changes: Record<string, unknown> = {};
  for (const k of keys) {
    if (d[k] === c0[k]) continue;
    if (k === "name" && !d[k]) throw new HttpError(400, "name: required");
    // Suppression is permanent unless an Owner/Chief explicitly corrects it (audited below).
    if (k === "email_status" && (c0.email_status === "opted_out" || c0.email_status === "bounced") && d[k] !== "opted_out" && !(c0.email_status === "bounced" && d[k] === "opted_out") && !isManager(actor))
      throw new HttpError(403, `This contact is marked ${c0.email_status}. Only the Owner or Chief can correct that.`);
    sets.push(`${k}=?`);
    args.push(d[k] as InValue);
    changes[k] = { from: c0[k], to: d[k] };
  }
  if (!sets.length) return;
  await run(`UPDATE contacts SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...args, now(), contactId]);
  await audit(actor, "update_contact", "contact", contactId, changes);
}

/* ---------- reads ---------- */
export type LeadFilters = {
  q?: string; owner?: number; market?: string; segment?: string; stage?: string; channel?: string; testOnly?: boolean;
  includeDemo?: boolean; includeHistorical?: boolean; page?: number; pageSize?: number; sort?: string;
};

export async function listLeads(actor: Actor, f: LeadFilters) {
  const s = leadScope(actor);
  const where = [s.sql];
  const args: InValue[] = [...s.args];
  if (!f.includeDemo) where.push("l.is_demo=0");
  if (f.testOnly) where.push("l.is_demo=1");
  // Historical-only (suppressed) entities are not outreach prospects: hidden unless asked for.
  if (!f.includeHistorical) where.push("l.historical_only=0");
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase()}%`;
    where.push(`(lower(l.company) LIKE ? OR l.domain LIKE ? OR lower(l.country) LIKE ? OR EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id=l.id AND (lower(c.name) LIKE ? OR lower(c.email) LIKE ?)))`);
    args.push(like, like, like, like, like);
  }
  if (f.owner) (where.push("l.owner_id=?"), args.push(f.owner));
  if (f.market) (where.push("l.market=?"), args.push(f.market));
  if (f.segment) (where.push("l.segment=?"), args.push(f.segment));
  if (f.stage) (where.push("l.stage=?"), args.push(f.stage));
  if (f.channel) (where.push("EXISTS (SELECT 1 FROM activities a WHERE a.lead_id=l.id AND a.channel=?)"), args.push(f.channel));
  const W = where.join(" AND ");
  const size = f.pageSize ?? 50;
  const page = Math.max(1, f.page ?? 1);
  const order =
    f.sort === "company" ? "lower(l.company) ASC"
    : f.sort === "due" ? "l.next_due_at IS NULL, l.next_due_at ASC"
    : "COALESCE(l.last_activity_at, l.created_at) DESC";
  const total = Number((await one(`SELECT COUNT(*) AS n FROM leads l WHERE ${W}`, args))!.n);
  const rows = await all(
    `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
     WHERE ${W} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size],
  );
  return { rows, total, page, pageSize: size };
}

export async function getLead(actor: Actor, id: number) {
  await assertLeadAccess(actor, id);
  const lead = (await one(
    `SELECT l.*, u.name AS owner_name, cb.name AS created_by_name, ib.name AS imported_by_name FROM leads l
     LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN users cb ON cb.id=l.created_by LEFT JOIN users ib ON ib.id=l.imported_by WHERE l.id=?`,
    [id],
  ))!;
  const contacts = await all("SELECT * FROM contacts WHERE lead_id=? ORDER BY is_primary DESC, id", [id]);
  const history = await all(
    `SELECT a.*, COALESCE(u.name,'Unknown original employee') AS actor_name, (a.actor_id IS NULL) AS actor_unknown, c.name AS contact_name, ib.name AS imported_by_name
     FROM activities a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN contacts c ON c.id=a.contact_id LEFT JOIN users ib ON ib.id=a.imported_by
     WHERE a.lead_id=? ORDER BY a.occurred_at DESC, a.id DESC`,
    [id],
  );
  const tasks = await all(
    `SELECT t.*, u.name AS assignee_name, cu.name AS completed_by_name FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN users cu ON cu.id=t.completed_by WHERE t.lead_id=? ORDER BY t.created_at DESC`,
    [id],
  );
  return { lead, contacts, history, tasks };
}
