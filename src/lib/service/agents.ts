import type { InValue } from "@libsql/client";
import { all, one, localMidnight, addDays, type Row } from "../db";
import { HttpError, isManager, type Actor } from "../auth";
import { TOOL_LABELS } from "../tool-labels";
import "../agent-tools"; // registers the MCP tool labels

/**
 * Reading the API request log (written by src/lib/api.ts): what every key did, step by step.
 * Owner and Chief see everything; anyone else sees only their own calls.
 */

/* ---------- a step in plain words ---------- */
const STEPS: [string, RegExp, string][] = [
  ["GET", /^\/guide$/, "Read the agent guide"],
  ["GET", /^\/openapi\.json$/, "Read the API description"],
  ["GET", /^\/me$/, "Checked its own account and permissions"],
  ["GET", /^\/work\/next$/, "Asked what to do next"],
  ["GET", /^\/changes$/, "Asked what changed since last time"],
  ["GET", /^\/requests$/, "Read the API request log"],
  ["GET", /^\/schedule$/, "Read the work schedule"],
  ["GET", /^\/lists$/, "Read the valid list values"],
  ["GET", /^\/capacity$/, "Checked today's sending capacity"],
  ["POST", /^\/duplicates\/check$/, "Checked for a duplicate before creating"],
  ["POST", /^\/duplicates\/reviews$/, "Asked a Chief to review a possible duplicate"],
  ["GET", /^\/leads\/duplicates$/, "Checked for a duplicate lead"],
  ["GET", /^\/leads$/, "Listed leads"],
  ["POST", /^\/leads$/, "Created a lead"],
  ["GET", /^\/leads\/\d+$/, "Opened a lead"],
  ["PATCH", /^\/leads\/\d+$/, "Updated a lead"],
  ["POST", /^\/leads\/\d+\/contacts$/, "Added a contact"],
  ["POST", /^\/leads\/\d+\/stage$/, "Changed a lead's stage"],
  ["POST", /^\/leads\/\d+\/activities$/, "Recorded work on a lead"],
  ["POST", /^\/leads\/\d+\/campaigns$/, "Put a lead in a campaign"],
  ["DELETE", /^\/leads\/\d+\/campaigns$/, "Removed a lead from a campaign"],
  ["GET", /^\/contacts\/\d+$/, "Opened a contact"],
  ["PATCH", /^\/contacts\/\d+$/, "Updated a contact"],
  ["GET", /^\/tasks$/, "Listed tasks"],
  ["POST", /^\/tasks$/, "Created a task"],
  ["GET", /^\/tasks\/\d+$/, "Opened a task"],
  ["PATCH", /^\/tasks\/\d+$/, "Updated a task"],
  ["POST", /^\/tasks\/\d+\/complete$/, "Completed a task"],
  ["POST", /^\/tasks\/\d+\/submit$/, "Submitted work for approval"],
  ["POST", /^\/tasks\/\d+\/reschedule$/, "Rescheduled a task"],
  ["POST", /^\/tasks\/reconcile$/, "Reconciled tasks with approvals and sends"],
  ["POST", /^\/(messages\/versions|message-versions)$/, "Wrote a message draft"],
  ["GET", /^\/(messages\/versions|message-versions)\/\d+$/, "Opened a message draft"],
  ["GET", /^\/message-versions$/, "Listed message drafts"],
  ["GET", /^\/message-versions\/\d+\/authorizations$/, "Checked who approved a draft"],
  ["POST", /^\/messages\/versions\/\d+\/edit$/, "Edited a draft (new version)"],
  ["POST", /^\/messages\/versions\/\d+\/reject$/, "Rejected a draft"],
  ["GET", /^\/messages\/decisions$/, "Read the Owner's decisions on drafts"],
  ["POST", /^\/authorizations(\/bulk)?$/, "Approved a draft"],
  ["DELETE", /^\/authorizations\/\d+$/, "Withdrew an approval"],
  ["GET", /^\/authorizations\/pending$/, "Listed drafts waiting for send approval"],
  ["GET", /^\/sends\/eligibility$/, "Checked whether a message may be sent"],
  ["POST", /^\/sends$/, "Recorded a sent message"],
  ["GET", /^\/sends$/, "Listed recorded sends"],
  ["POST", /^\/sends\/[^/]+\/reconcile$/, "Finished recording a send"],
  ["POST", /^\/replies$/, "Recorded a reply"],
  ["POST", /^\/bounces$/, "Recorded a bounce"],
  ["POST", /^\/complaints$/, "Recorded a spam complaint"],
  ["GET", /^\/reports$/, "Read a report"],
  ["GET", /^\/campaigns\/report$/, "Read the campaign report"],
  ["GET", /^\/campaigns/, "Read campaigns"],
  ["GET", /^\/senders/, "Read sender information"],
  ["GET", /^\/approvals/, "Read approvals"],
  ["POST", /^\/approvals\/\d+\/decision$/, "Decided an approval"],
  ["POST", /^\/import\//, "Ran a historical import"],
];
/** MCP tool calls are stored with method "TOOL" and the tool name as the path. */

export function stepLabel(method: string, path: string): string {
  if (method === "TOOL") return TOOL_LABELS[path] ?? `Used the tool ${path}`;
  for (const [m, re, label] of STEPS) if (m === method && re.test(path)) return label;
  return method === "GET" ? "Read data" : "Changed data";
}

/* ---------- reads ---------- */
export type RequestFilters = {
  actor?: number; outcome?: string; kind?: string; run?: string; lead?: number; task?: number; q?: string; from?: string; to?: string;
  page?: number; pageSize?: number; oldestFirst?: boolean;
};
const OUTCOMES = ["ok", "refused", "error", "replayed"];
const isYmd = (v?: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const decorate = (r: Row) => ({ ...r, step: stepLabel(r.method as string, r.path as string) }) as Row;

/** People without manager rights only ever see their own calls. */
const scope = (actor: Actor, requested?: number) => (isManager(actor) ? requested : actor.id);

export async function listRequests(actor: Actor, f: RequestFilters = {}) {
  const where: string[] = [];
  const args: InValue[] = [];
  const who = scope(actor, f.actor);
  if (who) (where.push("r.actor_id=?"), args.push(who));
  if (f.outcome) {
    if (!OUTCOMES.includes(f.outcome)) throw new HttpError(400, `outcome: one of ${OUTCOMES.join(", ")}.`);
    where.push("r.outcome=?"); args.push(f.outcome);
  }
  if (f.kind === "read" || f.kind === "write") (where.push("r.kind=?"), args.push(f.kind));
  if (f.run) (where.push("r.run_id=?"), args.push(f.run));
  if (f.lead) (where.push("r.lead_id=?"), args.push(f.lead));
  if (f.task) (where.push("r.task_id=?"), args.push(f.task));
  if (f.q?.trim()) { const like = `%${f.q.trim().toLowerCase()}%`; where.push("(lower(r.path) LIKE ? OR lower(COALESCE(r.error,'')) LIKE ? OR lower(COALESCE(r.error_code,'')) LIKE ?)"); args.push(like, like, like); }
  if (isYmd(f.from)) (where.push("r.at>=?"), args.push(localMidnight(f.from).toISOString()));
  if (isYmd(f.to)) (where.push("r.at<?"), args.push(localMidnight(addDays(f.to, 1)).toISOString()));
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const size = Math.min(Math.max(f.pageSize ?? 100, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const [totalRow, rows] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM api_requests r ${W}`, args),
    all(`SELECT r.*, u.is_agent, l.company FROM api_requests r LEFT JOIN users u ON u.id=r.actor_id LEFT JOIN leads l ON l.id=r.lead_id
         ${W} ORDER BY r.id ${f.oldestFirst ? "ASC" : "DESC"} LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]),
  ]);
  const total = Number(totalRow!.n);
  return { rows: rows.map(decorate), total, page, page_size: size, has_more: page * size < total };
}

/** One line per account that used the API in the last 7 days (or is marked as an AI agent): what it did in the last 24 hours. */
export async function agentSummary(actor: Actor) {
  const who = scope(actor);
  const day = new Date(Date.now() - 86400000).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await all(
    `SELECT u.id,u.name,u.is_agent,u.active,
       (SELECT MAX(r.at) FROM api_requests r WHERE r.actor_id=u.id) AS last_at,
       (SELECT COUNT(*) FROM api_requests r WHERE r.actor_id=u.id AND r.at>=?) AS steps,
       (SELECT COUNT(*) FROM api_requests r WHERE r.actor_id=u.id AND r.at>=? AND r.kind='write' AND r.outcome='ok') AS changes,
       (SELECT COUNT(*) FROM api_requests r WHERE r.actor_id=u.id AND r.at>=? AND r.outcome='refused') AS refused,
       (SELECT COUNT(*) FROM api_requests r WHERE r.actor_id=u.id AND r.at>=? AND r.outcome='error') AS errors
     FROM users u WHERE (u.is_agent=1 OR EXISTS (SELECT 1 FROM api_requests r WHERE r.actor_id=u.id AND r.at>=?))${who ? " AND u.id=?" : ""}
     ORDER BY last_at IS NULL, last_at DESC`, [day, day, day, day, week, ...(who ? [who] : [])]);
  return rows.map((r) => ({ id: r.id as number, name: r.name as string, isAgent: !!r.is_agent, active: !!r.active, lastAt: (r.last_at as string | null) ?? null,
    steps: Number(r.steps), changes: Number(r.changes), refused: Number(r.refused), errors: Number(r.errors) }));
}

/** The latest runs: calls that carried the same X-Run-Id header. */
export async function listRuns(actor: Actor, limit = 8) {
  const who = scope(actor);
  const rows = await all(
    `SELECT r.run_id, MIN(r.at) AS started, MAX(r.at) AS ended, COUNT(*) AS steps, MAX(r.actor_name) AS who,
            SUM(CASE WHEN r.outcome='refused' THEN 1 ELSE 0 END) AS refused, SUM(CASE WHEN r.outcome='error' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN r.kind='write' AND r.outcome='ok' THEN 1 ELSE 0 END) AS changes
     FROM api_requests r WHERE r.run_id IS NOT NULL${who ? " AND r.actor_id=?" : ""} GROUP BY r.run_id ORDER BY MAX(r.id) DESC LIMIT ?`, [...(who ? [who] : []), limit]);
  return rows.map((r) => ({ runId: r.run_id as string, started: r.started as string, ended: r.ended as string, steps: Number(r.steps), who: r.who as string | null,
    refused: Number(r.refused), errors: Number(r.errors), changes: Number(r.changes) }));
}

/** The latest API calls about one lead (lead page). */
export async function leadApiActivity(leadId: number, limit = 12) {
  const rows = await all("SELECT r.id,r.at,r.actor_name,r.method,r.path,r.outcome,r.error,r.kind,r.run_id,r.via FROM api_requests r WHERE r.lead_id=? ORDER BY r.id DESC LIMIT ?", [leadId, limit]);
  return rows.map(decorate);
}

/** Dashboard card: the latest steps of every agent, and a 24-hour count per account. */
export async function recentApiActivity(limit = 10) {
  const day = new Date(Date.now() - 86400000).toISOString();
  const [steps, per] = await Promise.all([
    all(`SELECT r.id,r.at,r.actor_id,r.actor_name,r.method,r.path,r.outcome,r.error,r.lead_id,r.task_id,r.run_id,l.company FROM api_requests r LEFT JOIN leads l ON l.id=r.lead_id ORDER BY r.id DESC LIMIT ?`, [limit]),
    all(`SELECT r.actor_id,MAX(r.actor_name) AS who,COUNT(*) AS n,SUM(CASE WHEN r.kind='write' AND r.outcome='ok' THEN 1 ELSE 0 END) AS changes,SUM(CASE WHEN r.outcome='refused' THEN 1 ELSE 0 END) AS refused
         FROM api_requests r WHERE r.at>=? AND r.actor_id IS NOT NULL GROUP BY r.actor_id ORDER BY n DESC LIMIT 6`, [day]),
  ]);
  return {
    steps: steps.map(decorate),
    last24h: per.map((r) => ({ id: r.actor_id as number, who: r.who as string, n: Number(r.n), changes: Number(r.changes), refused: Number(r.refused) })),
  };
}
