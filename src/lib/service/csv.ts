import Papa from "papaparse";
import { all, one } from "../db";
import { HttpError, requirePerm, type Actor } from "../auth";
import { createLead, findDuplicates, listLeads, type LeadFilters } from "./leads";
import { domainOf } from "./common";
import { getReport, rate, type Granularity } from "./reports";

export const MAX_IMPORT_ROWS = 500;

const ALIASES: Record<string, string[]> = {
  company: ["company", "company_name", "organisation", "organization", "name"],
  website: ["website", "url", "domain", "site"],
  industry: ["industry", "sector"],
  country: ["country"],
  market: ["market", "target_market"],
  language: ["language", "preferred_language"],
  source: ["source", "lead_source"],
  source_url: ["source_url", "source_link", "source_URL"],
  owner: ["owner", "owner_username", "assigned_to", "employee"],
  stage: ["stage", "status"],
  service: ["service", "service_of_interest"],
  notes: ["notes", "note", "comments"],
  next_action: ["next_action"],
  next_due_at: ["next_due", "next_due_at", "due_date", "due"],
  contact_name: ["contact_name", "contact", "person"],
  contact_role: ["contact_role", "role", "job_title", "title"],
  contact_email: ["contact_email", "email"],
  contact_phone: ["contact_phone", "phone", "telephone"],
  contact_linkedin: ["contact_linkedin", "linkedin", "linkedin_url"],
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

export type ImportRow = {
  line: number;
  company: string;
  status: "ok" | "duplicate" | "error";
  messages: string[];
  data?: Record<string, unknown>;
};

async function resolver(kind: string) {
  const rows = await all("SELECT key,label FROM lists WHERE kind=? AND active=1", [kind]);
  const m = new Map<string, string>();
  for (const r of rows) (m.set(r.key.toLowerCase(), r.key), m.set(r.label.toLowerCase(), r.key));
  return (v?: string) => (v ? m.get(v.trim().toLowerCase()) ?? null : null);
}

export async function prepareImport(actor: Actor, text: string): Promise<{ rows: ImportRow[]; unknownColumns: string[] }> {
  requirePerm(actor, "leads.import");
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: norm });
  if (!parsed.meta.fields?.length) throw new HttpError(400, "The file has no header row.");
  if (parsed.data.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time (found ${parsed.data.length}). Split the file.`);

  const fields = new Set(parsed.meta.fields);
  const colFor = (k: string) => ALIASES[k].map(norm).find((a) => fields.has(a));
  if (!colFor("company")) throw new HttpError(400, 'No "company" column found. Expected a header such as: company, website, country, market, stage, owner, contact_name, contact_email …');
  const known = new Set(Object.keys(ALIASES).flatMap((k) => ALIASES[k].map(norm)));
  const unknownColumns = [...fields].filter((f) => !known.has(f));

  const R = { stage: await resolver("stage"), market: await resolver("market"), industry: await resolver("industry"), language: await resolver("language"), source: await resolver("source"), service: await resolver("service") };
  const users = await all("SELECT id,username,name FROM users WHERE active=1");
  const seenDomains = new Set<string>();
  const seenCompanies = new Set<string>();
  const rows: ImportRow[] = [];

  for (const [i, raw] of parsed.data.entries()) {
    const get = (k: string) => {
      const c = colFor(k);
      return c ? (raw[c] ?? "").trim() : "";
    };
    const line = i + 2;
    const company = get("company");
    const messages: string[] = [];
    if (!company) {
      rows.push({ line, company: "(blank)", status: "error", messages: ["company is empty"] });
      continue;
    }
    const extra: string[] = [];
    const pick = (field: keyof typeof R, label: string) => {
      const v = get(field);
      if (!v) return null;
      const key = R[field](v);
      if (!key) (messages.push(`${label} "${v}" is not in the list — kept in notes`), extra.push(`${label}: ${v}`));
      return key;
    };
    const stageVal = get("stage");
    const stage = R.stage(stageVal);
    if (stageVal && !stage) (messages.push(`stage "${stageVal}" unknown — set to the first stage`), extra.push(`stage: ${stageVal}`));
    const market = pick("market", "market");
    const industry = pick("industry", "industry");
    const language = pick("language", "language");
    const service = pick("service", "service");
    let source = pick("source", "source");
    if (!get("source")) source = R.source("csv_import");

    const ownerVal = get("owner");
    let owner_id: number | null = null;
    if (ownerVal) {
      const u = users.find((x) => x.username.toLowerCase() === ownerVal.toLowerCase() || x.name.toLowerCase() === ownerVal.toLowerCase());
      if (u) owner_id = u.id;
      else messages.push(`owner "${ownerVal}" not found — left unassigned`);
    }
    const email = get("contact_email");
    const contact = get("contact_name") || email
      ? [{ name: get("contact_name") || email, role: get("contact_role"), email, phone: get("contact_phone"), linkedin: get("contact_linkedin") }]
      : [];
    const notes = [get("notes"), extra.length ? `[import] ${extra.join("; ")}` : ""].filter(Boolean).join("\n");

    const data = {
      company, website: get("website"), industry, country: get("country"), market, language, source, source_url: get("source_url"), owner_id,
      stage: stage ?? undefined, service, notes, next_action: get("next_action"), next_due_at: get("next_due_at"), contacts: contact,
    };

    const dom = domainOf(get("website"));
    const ckey = company.toLowerCase();
    let status: ImportRow["status"] = "ok";
    if ((dom && seenDomains.has(dom)) || seenCompanies.has(ckey)) (status = "duplicate", messages.push("duplicate of an earlier row in this file"));
    else {
      const dups = await findDuplicates({ company, website: get("website"), emails: email ? [email] : [] });
      if (dups.length) (status = "duplicate", messages.push(`already in CRM: ${dups[0].company} (#${dups[0].id}, ${dups[0].reason})`));
    }
    if (dom) seenDomains.add(dom);
    seenCompanies.add(ckey);
    rows.push({ line, company, status, messages, data });
  }
  return { rows, unknownColumns };
}

export async function commitImport(actor: Actor, text: string, importDuplicates: boolean) {
  const { rows } = await prepareImport(actor, text);
  let created = 0, skipped = 0, failed = 0;
  const errors: string[] = [];
  for (const r of rows) {
    if (r.status === "error" || !r.data) { failed++; errors.push(`Line ${r.line}: ${r.messages.join("; ")}`); continue; }
    if (r.status === "duplicate" && !importDuplicates) { skipped++; continue; }
    try {
      await createLead(actor, { ...r.data, allow_duplicate: true });
      created++;
    } catch (e) {
      failed++;
      errors.push(`Line ${r.line} (${r.company}): ${(e as Error).message}`);
    }
  }
  return { created, skipped, failed, errors: errors.slice(0, 20) };
}

/* ---------- exports ---------- */
const safe = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export async function leadsCsv(actor: Actor, filters: LeadFilters): Promise<string> {
  requirePerm(actor, "leads.export");
  const { rows } = await listLeads(actor, { ...filters, page: 1, pageSize: 5000 });
  const stage = Object.fromEntries((await all("SELECT key,label FROM lists WHERE kind='stage'")).map((r) => [r.key, r.label]));
  const out = [];
  for (const l of rows) {
    const c = await one("SELECT * FROM contacts WHERE lead_id=? ORDER BY is_primary DESC,id LIMIT 1", [l.id]);
    out.push({
      company: l.company, website: l.website, industry: l.industry, country: l.country, market: l.market, language: l.language,
      source: l.source, source_url: l.source_url, owner: l.owner_name, stage: stage[l.stage] ?? l.stage, service: l.service,
      last_activity: l.last_activity_at, next_action: l.next_action, next_due: l.next_due_at, notes: l.notes,
      contact_name: c?.name, contact_role: c?.role, contact_email: c?.email, contact_phone: c?.phone, contact_linkedin: c?.linkedin,
      contact_email_status: c?.email_status,
    });
  }
  return Papa.unparse(out.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, safe(v)]))));
}

export async function reportCsv(actor: Actor, g: Granularity, at?: string, employee?: number | null): Promise<string> {
  requirePerm(actor, "reports.export");
  const r = await getReport(actor, { granularity: g, at, employee });
  const pct = (a: number, b: number) => (rate(a, b) == null ? "" : `${(rate(a, b)! * 100).toFixed(1)}%`);
  const rows = r.buckets.map((b) => ({
    period: b.label, leads_added: b.m.leads_added, first_emails_sent: b.m.first_emails, first_email_bounces: b.m.first_email_bounces,
    first_email_bounce_rate: pct(b.m.first_email_bounces, b.m.first_emails), follow_ups_sent: b.m.follow_ups, follow_up_bounces: b.m.follow_up_bounces,
    follow_up_bounce_rate: pct(b.m.follow_up_bounces, b.m.follow_ups), replies: b.m.replies, meetings: b.m.meetings, won: b.m.won, lost: b.m.lost, tasks_completed: b.m.completed,
  }));
  return Papa.unparse(rows);
}
