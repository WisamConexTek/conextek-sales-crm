import { z } from "zod";
import { all, one, run, tx, now, type Row } from "../db";
import { HttpError, requirePerm, type Actor } from "../auth";
import { audit, parse, optText, optInt, reqText } from "./common";
import { assertLeadAccess } from "./leads";

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "closed"] as const;
export const PREP_STATUSES = ["validation_needed", "draft_needed", "internal_review", "user_approval_needed", "ready_for_execution"] as const;

export async function listProjects() {
  return all("SELECT id,key,name,status,created_at FROM projects ORDER BY id");
}
export async function listChannels() {
  return all("SELECT key,name,active FROM channels ORDER BY id");
}
export async function assertChannel(key: string | null | undefined) {
  if (!key) return;
  if (!(await one("SELECT key FROM channels WHERE key=? AND active=1", [key]))) throw new HttpError(400, `channel: "${key}" is not an active channel (email, linkedin, x).`);
}

/** Campaign rows with the numbers that are cheap and unambiguous. Fuller reporting comes in phase 3. */
export async function listCampaigns() {
  return all(
    `SELECT c.id,c.key,c.name,c.project_id,p.name AS project,c.owner_id,u.name AS owner_name,c.target_markets,c.objective,c.status,c.created_at,
       (SELECT COUNT(DISTINCT lc.lead_id) FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id
         WHERE lc.campaign_id=c.id AND lc.status='active' AND l.is_demo=0) AS unique_leads,
       (SELECT COUNT(*) FROM lead_campaigns lc JOIN leads l ON l.id=lc.lead_id
         WHERE lc.campaign_id=c.id AND lc.status='active' AND l.is_demo=0 AND l.historical_only=1) AS historical_only_leads
     FROM campaigns c JOIN projects p ON p.id=c.project_id LEFT JOIN users u ON u.id=c.owner_id ORDER BY c.id`,
  );
}
export async function getCampaign(id: number): Promise<Row> {
  const r = (await listCampaigns()).find((c) => c.id === id);
  if (!r) throw new HttpError(404, "Campaign not found.");
  return r;
}

const base = {
  name: reqText(120),
  project_id: optInt,
  owner_id: optInt,
  target_markets: z.preprocess((v) => (Array.isArray(v) ? v.map(String).join(", ") : v), optText(500)),
  objective: optText(1000),
  status: z.enum(CAMPAIGN_STATUSES),
};
const keyOf = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export async function createCampaign(actor: Actor, input: unknown) {
  requirePerm(actor, "campaigns.manage");
  const d = parse(z.object({ ...base, status: base.status.optional() }), input);
  const key = keyOf(d.name);
  if (!key) throw new HttpError(400, "name: needs letters or digits.");
  if (await one("SELECT id FROM campaigns WHERE key=?", [key])) throw new HttpError(409, `A campaign with key "${key}" already exists.`);
  const projectId = d.project_id ?? (await one("SELECT id FROM projects WHERE key='conextek'"))!.id;
  if (!(await one("SELECT id FROM projects WHERE id=?", [projectId]))) throw new HttpError(400, "project_id: unknown project.");
  if (d.owner_id && !(await one("SELECT id FROM users WHERE id=? AND active=1", [d.owner_id]))) throw new HttpError(400, "owner_id: unknown or disabled employee.");
  const t = now();
  const r = await run(
    "INSERT INTO campaigns (project_id,key,name,owner_id,target_markets,objective,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [projectId, key, d.name, d.owner_id, d.target_markets, d.objective, d.status ?? "draft", t, t],
  );
  await audit(actor, "create_campaign", "campaign", r.id, { key, name: d.name });
  return r.id;
}

export async function updateCampaign(actor: Actor, id: number, input: Record<string, unknown>) {
  requirePerm(actor, "campaigns.manage");
  const cur = await getCampaign(id);
  const shape = z.object({ name: base.name.optional(), owner_id: base.owner_id.optional(), target_markets: base.target_markets.optional(), objective: base.objective.optional(), status: base.status.optional() });
  const d = parse(shape, Object.fromEntries(Object.entries(input).filter(([k]) => k in shape.shape)));
  if (d.owner_id && !(await one("SELECT id FROM users WHERE id=? AND active=1", [d.owner_id]))) throw new HttpError(400, "owner_id: unknown or disabled employee.");
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== cur[k]) (sets.push(`${k}=?`), args.push(v as never), (changes[k] = { from: cur[k], to: v }));
  if (!sets.length) return;
  await run(`UPDATE campaigns SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...args, now(), id]);
  await audit(actor, "update_campaign", "campaign", id, changes);
}

/* ---------- membership ---------- */

/** Contact restrictions that forbid enrolment in any campaign. A new campaign never bypasses an opt-out. */
export async function enrolmentBlock(leadId: number): Promise<string | null> {
  const o = await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=? AND email_status='opted_out'", [leadId]);
  if (Number(o!.n) > 0) return "this lead has an opted-out contact (do not contact); it cannot be enrolled in or moved to a campaign";
  const l = await one("SELECT historical_only FROM leads WHERE id=?", [leadId]);
  if (l?.historical_only) return "this lead is historical-only and is not an outreach prospect";
  return null;
}

export async function leadCampaigns(leadId: number) {
  return all(
    `SELECT lc.id,lc.campaign_id,c.name AS campaign,c.key AS campaign_key,p.name AS project,lc.status,lc.is_original,lc.transferred_from,
            tf.name AS transferred_from_name,lc.added_by,u.name AS added_by_name,lc.note,lc.joined_at,lc.ended_at
     FROM lead_campaigns lc JOIN campaigns c ON c.id=lc.campaign_id JOIN projects p ON p.id=c.project_id
     LEFT JOIN campaigns tf ON tf.id=lc.transferred_from LEFT JOIN users u ON u.id=lc.added_by
     WHERE lc.lead_id=? ORDER BY lc.joined_at, lc.id`, [leadId]);
}

/**
 * Enrol a lead (idempotent). If it is already active in a different campaign, the caller must say so explicitly with
 * transfer_from_campaign_id (a transfer) — otherwise 409. History is never erased; the old row becomes 'transferred'.
 */
export async function enrolLead(actor: Actor, leadId: number, input: unknown, opts: { skipPerm?: boolean; skipAccess?: boolean } = {}) {
  if (!opts.skipPerm) requirePerm(actor, "campaigns.manage");
  const d = parse(z.object({ campaign_id: z.coerce.number().int(), transfer_from_campaign_id: optInt.optional(), note: optText(500).optional() }), input);
  if (!opts.skipAccess) await assertLeadAccess(actor, leadId);
  const camp = await one("SELECT id,status,name FROM campaigns WHERE id=?", [d.campaign_id]);
  if (!camp) throw new HttpError(400, "campaign_id: unknown campaign.");
  if (camp.status === "closed") throw new HttpError(400, `campaign_id: "${camp.name}" is closed.`);
  const block = await enrolmentBlock(leadId);
  if (block) throw new HttpError(409, `Not enrolled: ${block}.`);

  const mine = await one("SELECT id,status FROM lead_campaigns WHERE lead_id=? AND campaign_id=?", [leadId, d.campaign_id]);
  if (mine?.status === "active") return { id: mine.id as number, changed: false };
  const active = await all("SELECT campaign_id FROM lead_campaigns WHERE lead_id=? AND status='active'", [leadId]);
  const from = d.transfer_from_campaign_id ?? null;
  if (active.length && from == null)
    throw new HttpError(409, `This lead is already active in another campaign (id ${active.map((a) => a.campaign_id).join(", ")}). To move it, resend with transfer_from_campaign_id. Its history is kept and outreach does not restart.`);
  if (from != null && !active.some((a) => a.campaign_id === from)) throw new HttpError(400, "transfer_from_campaign_id: the lead is not active in that campaign.");
  const hadAny = (await one("SELECT COUNT(*) AS n FROM lead_campaigns WHERE lead_id=?", [leadId]))!.n as number;
  const t = now();
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  if (from != null) stmts.push({ sql: "UPDATE lead_campaigns SET status='transferred', ended_at=? WHERE lead_id=? AND campaign_id=? AND status='active'", args: [t, leadId, from] });
  if (mine) stmts.push({ sql: "UPDATE lead_campaigns SET status='active', ended_at=NULL, transferred_from=?, added_by=?, note=?, joined_at=? WHERE id=?", args: [from, actor.id, d.note ?? null, t, mine.id as number] });
  else stmts.push({ sql: "INSERT INTO lead_campaigns (lead_id,campaign_id,status,is_original,transferred_from,added_by,note,joined_at) VALUES (?,?,'active',?,?,?,?,?)", args: [leadId, d.campaign_id, Number(hadAny) === 0 ? 1 : 0, from, actor.id, d.note ?? null, t] });
  await tx(stmts);
  await audit(actor, from != null ? "transfer_lead_campaign" : "enrol_lead_campaign", "lead", leadId, { campaign_id: d.campaign_id, from });
  const row = await one("SELECT id FROM lead_campaigns WHERE lead_id=? AND campaign_id=?", [leadId, d.campaign_id]);
  return { id: row!.id as number, changed: true };
}

export async function removeFromCampaign(actor: Actor, leadId: number, campaignId: number) {
  requirePerm(actor, "campaigns.manage");
  await assertLeadAccess(actor, leadId);
  const r = await run("UPDATE lead_campaigns SET status='removed', ended_at=? WHERE lead_id=? AND campaign_id=? AND status='active'", [now(), leadId, campaignId]);
  if (!r.changes) throw new HttpError(404, "The lead is not active in that campaign.");
  await audit(actor, "remove_lead_campaign", "lead", leadId, { campaign_id: campaignId });
}

/** The migration-review queue: real leads with no campaign. Never auto-filled — membership needs evidence. */
export async function unassignedLeads(actor: Actor, page = 1, size = 100) {
  requirePerm(actor, "campaigns.manage");
  const W = "l.is_demo=0 AND l.historical_only=0 AND NOT EXISTS (SELECT 1 FROM lead_campaigns lc WHERE lc.lead_id=l.id AND lc.status='active')";
  const total = Number((await one(`SELECT COUNT(*) AS n FROM leads l WHERE ${W}`))!.n);
  const rows = await all(`SELECT l.id,l.company,l.country,l.market,l.segment,l.stage,l.source FROM leads l WHERE ${W} ORDER BY l.id LIMIT ? OFFSET ?`, [size, (Math.max(1, page) - 1) * size]);
  return { total, page, rows };
}
