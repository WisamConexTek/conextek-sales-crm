import type { InValue, Transaction } from "@libsql/client";
import { all, one, run, now, ready, todayYmd } from "../db";
import { HttpError, requirePerm, type Actor } from "../auth";
import { audit, domainOf, parseEventDate, eventDateText, type EventDate } from "./common";

/**
 * Historical import + original-date corrections.
 *
 * Nothing here sends, schedules or scrapes anything. It only RECORDS what already happened, keeping:
 *   - the original date of each thing (lead_date / occurred_at) separate from the day it was entered here (created_at),
 *   - the employee who did the original work (actor / created_by) separate from the person who imported it (imported_by),
 *   - a batch row + audit entries for traceability.
 * Re-sending the same data is safe: records are matched by external_id (or by their natural key) and skipped.
 */

export const MAX_HISTORY_RECORDS = 200;
const STATUS_RANK: Record<string, number> = { unknown: 0, ok: 1, bounced: 2, opted_out: 3 };
const CONTACT_STATUSES = Object.keys(STATUS_RANK);
const MESSAGE_KINDS = ["first_email", "follow_up", "other"];

type Rec = Record<string, unknown>;
type Status = "created" | "exists" | "duplicate" | "error";
type Result = { index: number; external_id: string | null; status: Status; id?: number; lead_id?: number; message?: string };

const str = (v: unknown, max = 4000): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------------------------------------------------------------------------------------- */
/*  Historical import                                                                              */
/* ---------------------------------------------------------------------------------------------- */
export async function importHistory(actor: Actor, body: Rec) {
  requirePerm(actor, "history.import");
  const label = str(body.label, 200);
  if (!label) throw new HttpError(400, 'label: a short name for this import is required (e.g. "Canton Fair 2025 outreach").');
  const arr = (k: string): Rec[] => {
    const v = body[k];
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => !isObj(x))) throw new HttpError(400, `${k}: must be an array of objects.`);
    return v as Rec[];
  };
  const sections = { leads: arr("leads"), messages: arr("messages"), replies: arr("replies"), bounces: arr("bounces"), do_not_contact: arr("do_not_contact") };
  const total = Object.values(sections).reduce((n, a) => n + a.length, 0);
  if (!total) throw new HttpError(400, "Nothing to import. Send at least one of: leads, messages, replies, bounces, do_not_contact.");
  if (total > MAX_HISTORY_RECORDS) throw new HttpError(400, `Send at most ${MAX_HISTORY_RECORDS} records per request (got ${total}). Split it into chunks — re-sending is safe, duplicates are skipped.`);
  const commit = body.commit === true;
  const allowDuplicate = body.allow_duplicate === true;
  const makeTest = body.is_test === true;

  // ---- reference data ----
  const users = await all("SELECT id,username,name FROM users");
  const findUser = (v: unknown): number | null => {
    const s = str(v)?.toLowerCase();
    if (!s) return null;
    return (users.find((u) => u.username.toLowerCase() === s) ?? users.find((u) => u.name.toLowerCase() === s))?.id ?? null;
  };
  const lists = new Map<string, { byKey: Map<string, string>; keys: string[] }>();
  for (const kind of ["stage", "market", "segment", "industry", "source", "service", "language", "channel"]) {
    const rows = await all("SELECT key,label FROM lists WHERE kind=? AND active=1 ORDER BY position,id", [kind]);
    const m = new Map<string, string>();
    for (const r of rows) (m.set(String(r.key).toLowerCase(), r.key), m.set(String(r.label).toLowerCase(), r.key));
    lists.set(kind, { byKey: m, keys: rows.map((r) => r.key) });
  }
  const listKey = (kind: string, v: unknown, field: string): string | null => {
    const s = str(v);
    if (!s) return null;
    const hit = lists.get(kind)!.byKey.get(s.toLowerCase());
    if (!hit) throw new Error(`${field}: "${s}" is not an active ${kind}. Accepted: ${lists.get(kind)!.keys.join(", ")}.`);
    return hit;
  };
  const batchEmployee = body.employee;
  const employeeOf = (r: Rec, fallback?: number | null): number => {
    const raw = r.employee ?? batchEmployee;
    if (raw == null || raw === "") {
      if (fallback) return fallback;
      throw new Error("employee: who did the original work (username) is required, per record or once at the top level.");
    }
    const id = findUser(raw);
    if (!id) throw new Error(`employee: no user "${String(raw)}". Use the username shown in Settings → People.`);
    return id;
  };
  const dateOf = (v: unknown, field: string, mustKnow: boolean): EventDate => {
    const e = parseEventDate(v);
    if (e === "invalid") throw new Error(`${field}: use YYYY-MM-DD (date only), YYYY-MM-DDTHH:mm, an ISO time, or omit/"unknown" if the date is not known.`);
    if (e.at && new Date(e.at).getTime() > Date.now() + 5 * 60000) throw new Error(`${field}: cannot be in the future.`);
    if (mustKnow && !e.at) throw new Error(`${field}: required.`);
    return e;
  };

  // ---- in-memory indexes of existing leads / activities ----
  type L = { id: number; company: string; domain: string | null; external_id: string | null; is_demo: number };
  const leadRows = (await all("SELECT id,company,domain,external_id,is_demo FROM leads")) as L[];
  const byId = new Map<number, L>(), byExt = new Map<string, L>(), byDomain = new Map<string, L[]>(), byCompany = new Map<string, L[]>();
  const addLead = (l: L) => {
    byId.set(l.id, l);
    if (l.external_id) byExt.set(l.external_id, l);
    if (l.is_demo) return; // test leads are never matched by name/site
    if (l.domain) byDomain.set(l.domain, [...(byDomain.get(l.domain) ?? []), l]);
    byCompany.set(l.company.toLowerCase(), [...(byCompany.get(l.company.toLowerCase()) ?? []), l]);
  };
  leadRows.forEach(addLead);
  const emailToLead = new Map<string, number>(); // in-batch contact emails -> lead
  const unique = (xs: L[] | undefined, what: string): L | null => {
    if (!xs || !xs.length) return null;
    if (new Set(xs.map((x) => x.id)).size > 1) throw new Error(`${what} matches more than one lead (${xs.map((x) => "#" + x.id).join(", ")}) — use lead.id or lead.external_id.`);
    return xs[0];
  };
  const resolveLead = (ref: unknown, field = "lead"): L => {
    if (!isObj(ref)) throw new Error(`${field}: required — an object such as {"external_id":"..."} or {"id":12} or {"website":"..."} or {"company":"..."}.`);
    let l: L | null = null;
    if (ref.id != null) l = byId.get(Number(ref.id)) ?? null;
    else if (ref.external_id != null) l = byExt.get(String(ref.external_id).trim()) ?? null;
    else if (ref.website != null) l = unique(byDomain.get(domainOf(String(ref.website)) ?? ""), `${field}.website`);
    else if (ref.company != null) l = unique(byCompany.get(String(ref.company).trim().toLowerCase()), `${field}.company`);
    else throw new Error(`${field}: give one of id, external_id, website or company.`);
    if (!l) throw new Error(`${field}: lead not found (${JSON.stringify(ref)}). Import the lead first, in the same request or earlier.`);
    return l;
  };

  const c = await ready();
  const t: Transaction = await c.transaction("write");
  const q = async (sql: string, args: InValue[] = []) => (await t.execute({ sql, args })).rows.map((r) => ({ ...r }) as Rec);
  const x = async (sql: string, args: InValue[] = []) => {
    const r = await t.execute({ sql, args });
    return Number(r.lastInsertRowid ?? 0);
  };
  const at = now();
  let batchId: number | null = null;
  const ensureBatch = async () => (batchId ??= await x("INSERT INTO import_batches (kind,label,imported_by,created_at) VALUES ('history',?,?,?)", [label, actor.id, at]));

  const actByExt = new Map<string, { id: number; lead_id: number; contact_id: number | null; message_kind: string | null; actor_id: number; occurred_at: string; precision: string }>();
  const loadAct = async (ext: string) => {
    if (actByExt.has(ext)) return actByExt.get(ext)!;
    const [r] = await q("SELECT id,lead_id,contact_id,message_kind,actor_id,occurred_at,occurred_precision AS precision FROM activities WHERE external_id=?", [ext]);
    if (!r) return null;
    const v = { id: Number(r.id), lead_id: Number(r.lead_id), contact_id: r.contact_id == null ? null : Number(r.contact_id), message_kind: r.message_kind as string | null, actor_id: Number(r.actor_id), occurred_at: String(r.occurred_at), precision: String(r.precision) };
    actByExt.set(ext, v);
    return v;
  };

  /** Find a lead's contact by email (optionally creating one). Never lowers a deliverability state. */
  const contactFor = async (leadId: number, email: unknown, create: { status?: string; name?: string | null } | false) => {
    const e = str(email)?.toLowerCase();
    if (!e) return null;
    if (!EMAIL.test(e)) throw new Error(`contact_email: "${e}" is not a valid email.`);
    const [row] = await q("SELECT id,email_status FROM contacts WHERE lead_id=? AND lower(email)=?", [leadId, e]);
    if (row) return { id: Number(row.id), status: String(row.email_status) };
    if (!create) return null;
    const status = create.status && CONTACT_STATUSES.includes(create.status) ? create.status : "unknown";
    const primary = Number((await q("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=?", [leadId]))[0].n) === 0 ? 1 : 0;
    const id = await x(
      "INSERT INTO contacts (lead_id,name,email,email_status,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [leadId, create.name || e, e, status, primary, at, at],
    );
    emailToLead.set(e, leadId);
    return { id, status };
  };
  const escalate = async (contactId: number, current: string, next: string) => {
    if ((STATUS_RANK[next] ?? 0) > (STATUS_RANK[current] ?? 0)) {
      await x("UPDATE contacts SET email_status=?, updated_at=? WHERE id=?", [next, at, contactId]);
      return true;
    }
    return false;
  };

  const out: Record<keyof typeof sections, Result[]> = { leads: [], messages: [], replies: [], bounces: [], do_not_contact: [] };
  const warnings: string[] = [];
  let contactsEscalated = 0;
  const fail = (sec: keyof typeof out, i: number, ext: string | null, e: unknown) =>
    out[sec].push({ index: i, external_id: ext, status: "error", message: e instanceof Error ? e.message : String(e) });

  try {
    /* ---------------- leads ---------------- */
    for (const [i, r] of sections.leads.entries()) {
      const ext = str(r.external_id, 120);
      try {
        // Same external_id already imported -> skip.
        if (ext && byExt.has(ext)) {
          const l = byExt.get(ext)!;
          out.leads.push({ index: i, external_id: ext, status: "exists", id: l.id, message: "Already imported with this external_id." });
          continue;
        }
        const company = str(r.company, 200);
        if (!company) throw new Error("company: required.");
        const website = str(r.website, 300);
        const contacts = Array.isArray(r.contacts) ? (r.contacts as unknown[]) : [];
        if (contacts.some((cc) => !isObj(cc))) throw new Error("contacts: must be an array of objects.");
        const cs = (contacts as Rec[]).map((cc) => {
          const email = str(cc.email, 200)?.toLowerCase() ?? null;
          if (email && !EMAIL.test(email)) throw new Error(`contacts.email: "${email}" is not a valid email.`);
          const st = cc.do_not_contact === true ? "opted_out" : str(cc.email_status) ?? "unknown";
          if (!CONTACT_STATUSES.includes(st)) throw new Error(`contacts.email_status: ${CONTACT_STATUSES.join(", ")}.`);
          const name = str(cc.name, 120) ?? email;
          if (!name) throw new Error("contacts: each contact needs a name or an email.");
          return { name, role: str(cc.role, 120), email, phone: str(cc.phone, 60), linkedin: str(cc.linkedin, 300), status: st };
        });

        // Duplicate check (same website, company name or contact email) -> keep the existing lead, only carry over do-not-contact states.
        let dup: L | null = null, reason = "";
        const dom = domainOf(website);
        if (!allowDuplicate && !makeTest) {
          dup = unique(dom ? byDomain.get(dom) : undefined, "website");
          if (dup) reason = `same website (${dom})`;
          if (!dup) { dup = unique(byCompany.get(company.toLowerCase()), "company"); if (dup) reason = "same company name"; }
          if (!dup)
            for (const cc of cs) {
              if (!cc.email) continue;
              const hit = emailToLead.get(cc.email) ?? ((await q("SELECT c.lead_id FROM contacts c JOIN leads l ON l.id=c.lead_id WHERE lower(c.email)=? AND l.is_demo=0 LIMIT 1", [cc.email]))[0]?.lead_id as number | undefined);
              if (hit && byId.get(Number(hit))) { dup = byId.get(Number(hit))!; reason = `same contact email (${cc.email})`; break; }
            }
        }
        if (dup) {
          // Validate the original-employee/date fields anyway so mistakes are caught, then preserve suppression.
          for (const cc of cs) {
            if (!cc.email) continue;
            const found = await contactFor(dup.id, cc.email, STATUS_RANK[cc.status] >= 2 ? { status: cc.status, name: cc.name } : false);
            if (found && (await escalate(found.id, found.status, cc.status))) contactsEscalated++;
          }
          out.leads.push({ index: i, external_id: ext, status: "duplicate", id: dup.id, message: `Not created — ${reason} matches lead #${dup.id} (${dup.company}). Later records can still refer to it.` });
          if (ext && !byExt.has(ext)) byExt.set(ext, dup); // later rows in this batch resolve to the existing lead
          continue;
        }

        const employee = employeeOf(r);
        const ld = dateOf(r.lead_date, "lead_date", false);
        const stage = r.stage ? listKey("stage", r.stage, "stage")! : (lists.get("stage")!.keys[0] ?? "");
        const fields = {
          industry: listKey("industry", r.industry, "industry"), market: listKey("market", r.market, "market"), segment: listKey("segment", r.segment, "segment"),
          language: listKey("language", r.language, "language"), source: listKey("source", r.source, "source"), service: listKey("service", r.service, "service"),
        };
        const bid = await ensureBatch();
        const id = await x(
          `INSERT INTO leads (company,website,domain,industry,country,market,segment,language,source,source_url,owner_id,stage,service,notes,is_demo,created_by,created_at,updated_at,
                              lead_date,lead_date_precision,external_id,imported_by,import_batch_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [company, website, dom, fields.industry, str(r.country, 80), fields.market, fields.segment, fields.language, fields.source, str(r.source_url, 500),
            null, stage, fields.service, str(r.notes, 8000), makeTest || r.is_test === true ? 1 : 0, employee, at, at,
            ld.at, ld.precision === "unknown" ? null : ld.precision, ext, actor.id, bid],
        );
        for (const [k, cc] of cs.entries()) {
          await x(
            "INSERT INTO contacts (lead_id,name,role,email,phone,linkedin,email_status,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [id, cc.name, cc.role, cc.email, cc.phone, cc.linkedin, cc.status, k === 0 ? 1 : 0, at, at],
          );
          if (cc.email) emailToLead.set(cc.email, id);
        }
        const nl: L = { id, company, domain: dom, external_id: ext, is_demo: makeTest || r.is_test === true ? 1 : 0 };
        addLead(nl);
        out.leads.push({ index: i, external_id: ext, status: "created", id, message: ld.at ? undefined : "Created with an UNKNOWN lead date (not counted in period reports)." });
      } catch (e) {
        fail("leads", i, ext, e);
      }
    }

    /* ---------------- shared activity insert ---------------- */
    const insertActivity = async (a: {
      lead: L; type: string; kind?: string | null; outcome?: string | null; channel?: string | null; title?: string | null; body?: string | null; ref?: string | null; url?: string | null;
      contactId?: number | null; parentId?: number | null; employee: number; when: EventDate; ext: string | null;
    }) => {
      const bid = await ensureBatch();
      const occurred = a.when.at ?? at;
      const id = await x(
        `INSERT INTO activities (lead_id,contact_id,parent_id,type,message_kind,channel,outcome,title,body,ref,url,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,imported_by,import_batch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [a.lead.id, a.contactId ?? null, a.parentId ?? null, a.type, a.kind ?? null, a.channel ?? null, a.outcome ?? null, a.title ?? null, a.body ?? null, a.ref ?? null, a.url ?? null,
          a.employee, occurred, at, a.lead.is_demo, a.when.precision, a.ext, actor.id, bid],
      );
      if (a.when.at) await x("UPDATE leads SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END WHERE id=?", [occurred, occurred, a.lead.id]);
      return id;
    };
    const sameAsExisting = async (ext: string | null, key: { lead: number; type: string; channel: string | null; kind: string | null; at: string; employee: number; contact: number | null; title: string | null }) => {
      if (ext) {
        const e = await loadAct(ext);
        if (e) return e.id;
      }
      const [r] = await q(
        `SELECT id FROM activities WHERE lead_id=? AND type=? AND COALESCE(channel,'')=COALESCE(?,'') AND COALESCE(message_kind,'')=COALESCE(?,'')
           AND occurred_at=? AND occurred_precision<>'unknown' AND actor_id=? AND COALESCE(contact_id,0)=COALESCE(?,0) AND COALESCE(title,'')=COALESCE(?,'') LIMIT 1`,
        [key.lead, key.type, key.channel, key.kind, key.at, key.employee, key.contact, key.title],
      );
      return r ? Number(r.id) : null;
    };

    /* ---------------- sent messages ---------------- */
    for (const [i, r] of sections.messages.entries()) {
      const ext = str(r.external_id, 120);
      try {
        const lead = resolveLead(r.lead);
        const channel = listKey("channel", r.channel, "channel");
        if (!channel) throw new Error(`channel: required (${lists.get("channel")!.keys.join(", ")}).`);
        const kind = str(r.kind) ?? str(r.message_kind);
        if (!kind || !MESSAGE_KINDS.includes(kind)) throw new Error(`kind: ${MESSAGE_KINDS.join(", ")} (a first email, a follow-up, or anything else).`);
        const when = dateOf(r.sent_at, "sent_at", false);
        if (!when.at && !ext) throw new Error("external_id: required when sent_at is unknown (it is the only way to avoid duplicates).");
        const subject = str(r.subject, 200), text = str(r.body, 20000), ref = str(r.ref, 300), url = str(r.url, 600);
        if (!subject && !text && !ref && !url) throw new Error("Include the subject/body or a reference/link.");
        const employee = employeeOf(r);
        const contact = await contactFor(lead.id, r.contact_email, { name: str(r.contact_name, 120) });
        const dupId = await sameAsExisting(ext, { lead: lead.id, type: "message", channel, kind, at: when.at ?? "", employee, contact: contact?.id ?? null, title: subject });
        if (dupId) { out.messages.push({ index: i, external_id: ext, status: "exists", id: dupId, lead_id: lead.id, message: "Already recorded." }); continue; }
        if (contact && contact.status !== "unknown" && contact.status !== "ok") warnings.push(`messages[${i}]: contact is marked ${contact.status}. Recorded as history only.`);
        const id = await insertActivity({ lead, type: "message", kind, outcome: "sent", channel, title: subject, body: text, ref, url, contactId: contact?.id, employee, when, ext });
        if (ext) actByExt.set(ext, { id, lead_id: lead.id, contact_id: contact?.id ?? null, message_kind: kind, actor_id: employee, occurred_at: when.at ?? at, precision: when.precision });
        out.messages.push({ index: i, external_id: ext, status: "created", id, lead_id: lead.id });
      } catch (e) {
        fail("messages", i, ext, e);
      }
    }

    /* ---------------- replies ---------------- */
    for (const [i, r] of sections.replies.entries()) {
      const ext = str(r.external_id, 120);
      try {
        const replyTo = str(r.in_reply_to, 120);
        const parent = replyTo ? await loadAct(replyTo) : null;
        if (replyTo && !parent) throw new Error(`in_reply_to: no sent message with external_id "${replyTo}".`);
        const lead = r.lead != null ? resolveLead(r.lead) : parent ? byId.get(parent.lead_id)! : resolveLead(undefined);
        if (parent && parent.lead_id !== lead.id) throw new Error("in_reply_to: that message belongs to a different lead.");
        const channel = listKey("channel", r.channel, "channel") ?? null;
        if (!channel) throw new Error(`channel: required (${lists.get("channel")!.keys.join(", ")}).`);
        const when = dateOf(r.received_at, "received_at", false);
        if (!when.at && !ext) throw new Error("external_id: required when received_at is unknown.");
        const subject = str(r.subject, 200), text = str(r.body, 20000), ref = str(r.ref, 300), url = str(r.url, 600);
        if (!text && !ref && !url) throw new Error("Paste the reply text or give a reference/link.");
        const employee = employeeOf(r, parent?.actor_id);
        const contact = (await contactFor(lead.id, r.contact_email, { name: str(r.contact_name, 120) })) ?? (parent?.contact_id ? { id: parent.contact_id, status: "" } : null);
        const dupId = await sameAsExisting(ext, { lead: lead.id, type: "reply", channel, kind: null, at: when.at ?? "", employee, contact: contact?.id ?? null, title: subject });
        if (dupId) { out.replies.push({ index: i, external_id: ext, status: "exists", id: dupId, lead_id: lead.id, message: "Already recorded." }); continue; }
        const id = await insertActivity({ lead, type: "reply", outcome: "reply_received", channel, title: subject, body: text, ref, url, contactId: contact?.id, parentId: parent?.id, employee, when, ext });
        if (contact) {
          const [cr] = await q("SELECT email_status FROM contacts WHERE id=?", [contact.id]);
          if (cr?.email_status === "unknown") await x("UPDATE contacts SET email_status='ok', updated_at=? WHERE id=?", [at, contact.id]);
        }
        out.replies.push({ index: i, external_id: ext, status: "created", id, lead_id: lead.id });
      } catch (e) {
        fail("replies", i, ext, e);
      }
    }

    /* ---------------- bounces ---------------- */
    for (const [i, r] of sections.bounces.entries()) {
      const ext = str(r.external_id, 120);
      try {
        const mExt = str(r.message_external_id, 120);
        let parent = mExt ? await loadAct(mExt) : null;
        if (!parent && r.message_id != null) {
          const [p] = await q("SELECT id,lead_id,contact_id,message_kind,actor_id,occurred_at,occurred_precision AS precision FROM activities WHERE id=? AND type='message'", [Number(r.message_id)]);
          if (p) parent = { id: Number(p.id), lead_id: Number(p.lead_id), contact_id: p.contact_id == null ? null : Number(p.contact_id), message_kind: p.message_kind as string | null, actor_id: Number(p.actor_id), occurred_at: String(p.occurred_at), precision: String(p.precision) };
        }
        if (!parent) throw new Error('message_external_id: the sent message this bounce belongs to is required (import the message first, or give its CRM id as "message_id").');
        const lead = byId.get(parent.lead_id)!;
        const when = dateOf(r.bounced_at, "bounced_at", false);
        if (!when.at && !ext) throw new Error("external_id: required when bounced_at is unknown.");
        if (when.at && parent.precision !== "unknown" && when.at < parent.occurred_at && eventDayBefore(when, parent)) throw new Error("bounced_at: a bounce cannot be earlier than the message it belongs to.");
        const employee = employeeOf(r, parent.actor_id);
        const already = ext ? await loadAct(ext) : null;
        const [dupB] = already ? [{ id: already.id }] : await q("SELECT id FROM activities WHERE parent_id=? AND outcome='bounced' LIMIT 1", [parent.id]);
        if (dupB) { out.bounces.push({ index: i, external_id: ext, status: "exists", id: Number(dupB.id), lead_id: lead.id, message: "A bounce is already recorded for that message." }); continue; }
        const id = await insertActivity({ lead, type: "outcome", kind: parent.message_kind, outcome: "bounced", body: str(r.note, 2000), contactId: parent.contact_id, parentId: parent.id, employee, when, ext, channel: null });
        if (parent.contact_id) {
          const [cr] = await q("SELECT email_status FROM contacts WHERE id=?", [parent.contact_id]);
          if (cr && (await escalate(parent.contact_id, String(cr.email_status), "bounced"))) contactsEscalated++;
        }
        if (ext) actByExt.set(ext, { id, lead_id: lead.id, contact_id: parent.contact_id, message_kind: parent.message_kind, actor_id: employee, occurred_at: when.at ?? at, precision: when.precision });
        out.bounces.push({ index: i, external_id: ext, status: "created", id, lead_id: lead.id });
      } catch (e) {
        fail("bounces", i, ext, e);
      }
    }

    /* ---------------- do-not-contact / opt-outs ---------------- */
    for (const [i, r] of sections.do_not_contact.entries()) {
      const ext = str(r.external_id, 120);
      try {
        const lead = resolveLead(r.lead);
        const email = str(r.email);
        if (!email) throw new Error("email: required — the address that must not be contacted again.");
        const status = str(r.status) ?? "opted_out";
        if (!["opted_out", "bounced"].includes(status)) throw new Error("status: opted_out (default) or bounced.");
        const when = dateOf(r.at, "at", false);
        const employee = employeeOf(r);
        if (ext && (await loadAct(ext))) { out.do_not_contact.push({ index: i, external_id: ext, status: "exists", lead_id: lead.id, message: "Already recorded." }); continue; }
        const contact = (await contactFor(lead.id, email, { status, name: str(r.contact_name, 120) }))!;
        const changed = await escalate(contact.id, contact.status, status);
        if (changed) contactsEscalated++;
        // Leave a visible note in the lead history (only once per contact+status unless an external_id says otherwise).
        const title = status === "opted_out" ? "Do not contact (imported)" : "Bounced address (imported)";
        const note = str(r.note, 2000) ?? `${email} marked ${status === "opted_out" ? "do-not-contact" : "bounced"} from historical records.`;
        const dupId = await sameAsExisting(ext, { lead: lead.id, type: "note", channel: null, kind: null, at: when.at ?? "", employee, contact: contact.id, title });
        if (dupId) { out.do_not_contact.push({ index: i, external_id: ext, status: "exists", id: dupId, lead_id: lead.id, message: changed ? "Contact status updated; note already existed." : "Already recorded." }); continue; }
        const id = await insertActivity({ lead, type: "note", title, body: note, contactId: contact.id, employee, when, ext });
        if (ext) actByExt.set(ext, { id, lead_id: lead.id, contact_id: contact.id, message_kind: null, actor_id: employee, occurred_at: when.at ?? at, precision: when.precision });
        out.do_not_contact.push({ index: i, external_id: ext, status: "created", id, lead_id: lead.id });
      } catch (e) {
        fail("do_not_contact", i, ext, e);
      }
    }

    const counts = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, { created: v.filter((r) => r.status === "created").length, exists: v.filter((r) => r.status === "exists").length, duplicate: v.filter((r) => r.status === "duplicate").length, errors: v.filter((r) => r.status === "error").length }]),
    );
    const errors = Object.values(counts).reduce((n, c) => n + c.errors, 0);
    const created = Object.values(counts).reduce((n, c) => n + c.created, 0);
    const willCommit = commit && errors === 0;
    if (willCommit) {
      if (batchId) await t.execute({ sql: "UPDATE import_batches SET summary=? WHERE id=?", args: [JSON.stringify({ counts, contacts_escalated: contactsEscalated, warnings: warnings.length }), batchId] });
      await t.commit();
    } else await t.rollback();
    if (willCommit && batchId) await audit(actor, "import_history", "import_batch", batchId, { label, counts, contacts_escalated: contactsEscalated });
    return {
      committed: willCommit,
      dry_run: !commit,
      batch_id: willCommit ? batchId : null,
      note: !commit
        ? "Dry run — nothing was saved. Send the same body with \"commit\": true to save it."
        : errors
          ? "Nothing was saved because some records have errors. Fix them and send the whole request again (already-imported records are skipped)."
          : created
            ? "Saved."
            : "Saved — everything was already in the CRM, so nothing new was created.",
      counts, contacts_escalated: contactsEscalated, warnings, results: out,
    };
  } catch (e) {
    await t.rollback().catch(() => undefined);
    throw e;
  } finally {
    t.close();
  }
}

/** A bounce earlier in time than its message only counts as an error when both carry a real hour or fall on different days. */
function eventDayBefore(when: EventDate, parent: { occurred_at: string; precision: string }) {
  if (when.precision === "day" || parent.precision === "day") return todayYmd(undefined, new Date(when.at!)) < todayYmd(undefined, new Date(parent.occurred_at));
  return true;
}

/* ---------------------------------------------------------------------------------------------- */
/*  Bulk correction of lead dates (existing leads — never deletes or duplicates anything)          */
/* ---------------------------------------------------------------------------------------------- */
export type DateFixRow = {
  index: number;
  status: "will_change" | "changed" | "unchanged" | "not_found" | "ambiguous" | "error";
  lead_id?: number;
  company?: string;
  from?: string;
  to?: string;
  message?: string;
};

export async function correctLeadDates(actor: Actor, body: Rec) {
  requirePerm(actor, "history.import");
  const recs = body.records;
  if (!Array.isArray(recs) || !recs.length || recs.some((r) => !isObj(r))) throw new HttpError(400, 'records: a non-empty array of objects is required, e.g. {"external_id":"..." | "id":12 | "website":"..." | "company":"...", "lead_date":"2025-03-14"}.');
  if (recs.length > 500) throw new HttpError(400, "Send at most 500 records per request.");
  const commit = body.commit === true;
  const label = str(body.label, 200) ?? "Lead date correction";

  const leads = await all("SELECT id,company,domain,external_id,lead_date,lead_date_precision,created_by FROM leads");
  const users = await all("SELECT id,username,name FROM users");
  const out: DateFixRow[] = [];
  const plan: { row: DateFixRow; id: number; ev: EventDate; employee: number | null; before: Rec }[] = [];
  const show = (l: Rec) => (l.lead_date ? eventDateText(l.lead_date as string, l.lead_date_precision as string) : "unknown");

  for (const [index, r] of (recs as Rec[]).entries()) {
    try {
      let hits: Rec[] = [];
      if (r.id != null && r.id !== "") hits = leads.filter((l) => l.id === Number(r.id));
      else if (str(r.external_id)) hits = leads.filter((l) => l.external_id === str(r.external_id));
      else if (str(r.website)) hits = leads.filter((l) => l.domain && l.domain === domainOf(str(r.website)));
      else if (str(r.company)) hits = leads.filter((l) => String(l.company).toLowerCase() === str(r.company)!.toLowerCase());
      else throw new Error("No way to find the lead: give id, external_id, website or company.");
      if (!hits.length) { out.push({ index, status: "not_found", message: "No matching lead. Nothing is created by a correction." }); continue; }
      if (hits.length > 1) { out.push({ index, status: "ambiguous", message: `Matches ${hits.length} leads (${hits.map((h) => "#" + h.id).join(", ")}) — use id or external_id.` }); continue; }
      const l = hits[0];
      if (r.lead_date == null || String(r.lead_date).trim() === "") throw new Error('lead_date: required (YYYY-MM-DD, YYYY-MM-DDTHH:mm, or "unknown" to clear it).');
      const ev = parseEventDate(r.lead_date);
      if (ev === "invalid") throw new Error('lead_date: use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or "unknown".');
      if (ev.at && new Date(ev.at).getTime() > Date.now() + 5 * 60000) throw new Error("lead_date: cannot be in the future.");
      let employee: number | null = null;
      if (str(r.employee)) {
        const s = str(r.employee)!.toLowerCase();
        employee = (users.find((u) => u.username.toLowerCase() === s) ?? users.find((u) => u.name.toLowerCase() === s))?.id ?? null;
        if (!employee) throw new Error(`employee: no user "${str(r.employee)}".`);
      }
      const same = ev.at === l.lead_date && (ev.precision === "unknown" ? null : ev.precision) === l.lead_date_precision;
      const sameEmp = employee == null || employee === l.created_by;
      const row: DateFixRow = {
        index, lead_id: l.id as number, company: l.company as string, from: show(l), to: ev.at ? eventDateText(ev.at, ev.precision) : "unknown",
        status: same && sameEmp ? "unchanged" : "will_change",
      };
      out.push(row);
      if (row.status === "will_change") plan.push({ row, id: l.id as number, ev, employee: sameEmp ? null : employee, before: l });
    } catch (e) {
      out.push({ index, status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const errors = out.filter((r) => r.status === "error").length;
  let batchId: number | null = null;
  if (commit && errors === 0 && plan.length) {
    const t = now();
    batchId = (await run("INSERT INTO import_batches (kind,label,imported_by,summary,created_at) VALUES ('date_fix',?,?,?,?)", [label, actor.id, JSON.stringify({ changed: plan.length }), t])).id;
    for (const p of plan) {
      const sets = ["lead_date=?", "lead_date_precision=?", "updated_at=?"];
      const args: InValue[] = [p.ev.at, p.ev.precision === "unknown" ? null : p.ev.precision, t];
      if (p.employee) (sets.push("created_by=?"), args.push(p.employee));
      await run(`UPDATE leads SET ${sets.join(",")} WHERE id=?`, [...args, p.id]);
      await audit(actor, "correct_lead_date", "lead", p.id, {
        batch_id: batchId, label,
        lead_date: { from: p.row.from, to: p.row.to },
        ...(p.employee ? { original_employee: { from: p.before.created_by, to: p.employee } } : {}),
        note: "The date the lead was entered into the CRM (created_at) is unchanged.",
      });
      p.row.status = "changed";
    }
  }
  const count = (s: DateFixRow["status"]) => out.filter((r) => r.status === s).length;
  return {
    committed: !!batchId, dry_run: !commit, batch_id: batchId,
    note: !commit ? 'Dry run — nothing was changed. Send the same body with "commit": true to apply.' : errors ? "Nothing was changed because some records have errors. Fix them and send again." : batchId ? "Dates corrected." : "Nothing needed changing.",
    counts: { changed: count("changed"), will_change: count("will_change"), unchanged: count("unchanged"), not_found: count("not_found"), ambiguous: count("ambiguous"), errors },
    results: out,
  };
}

export async function recentBatches(limit = 10) {
  return all(
    `SELECT b.id,b.kind,b.label,b.summary,b.created_at,u.name AS imported_by_name FROM import_batches b JOIN users u ON u.id=b.imported_by ORDER BY b.id DESC LIMIT ?`,
    [limit],
  );
}
export async function dateStatus() {
  const l = await one("SELECT COUNT(*) AS total, SUM(lead_date IS NULL) AS unknown FROM leads WHERE is_demo=0");
  return { total: Number(l!.total), unknown: Number(l!.unknown ?? 0) };
}
