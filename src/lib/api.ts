import { randomBytes } from "node:crypto";
import { getApiActor, HttpError, type Actor } from "./auth";
import { one, run, now } from "./db";

/**
 * The one door every API call goes through (REST routes and MCP tool calls alike):
 *   authenticate -> replay an Idempotency-Key if we have seen it -> run the handler -> uniform JSON
 *   -> write ONE row to api_requests, whatever happened (success, refusal, error; reads as well as writes).
 * That row is what the Agent activity page shows, so an agent's every step is visible, not only its saved changes.
 */

export type ApiCtx<P> = { actor: Actor; req: Request; params: P; url: URL; body: () => Promise<Record<string, unknown>> };
type Json = Record<string, unknown>;
export type ApiResult = { status: number; json: Json; requestId: string };

/** Internally the flag is "is_demo"; the API and UI call it test data ("is_test": true/false). */
function publicShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(publicShape);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k === "is_demo" ? "is_test" : k] = k === "is_demo" ? !!x : publicShape(x);
    return out;
  }
  return v;
}

/** Stable machine-readable error codes. A handler can set its own (new HttpError(409, "...", "duplicate")). */
const DEFAULT_CODE: Record<number, string> = { 400: "invalid_input", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large", 429: "rate_limited" };
const codeOf = (e: HttpError & { duplicates?: unknown }) => e.code ?? (e.duplicates ? "duplicate" : DEFAULT_CODE[e.status] ?? (e.status >= 500 ? "server_error" : "error"));

const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n)}…` : s);
const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};
const header = (req: Request, name: string, max: number) => {
  const v = (req.headers.get(name) ?? "").trim();
  return v ? v.slice(0, max) : null;
};

/** A short description of what came back, small enough to store on every request. */
function summarize(data: unknown): string | null {
  if (data == null) return null;
  if (Array.isArray(data)) return `${data.length} item${data.length === 1 ? "" : "s"}`;
  if (typeof data !== "object") return clip(String(data), 300);
  const o = data as Json;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) parts.push(`${k}: ${v.length} item${v.length === 1 ? "" : "s"}`);
    else if (v === null || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    else if (typeof v === "string") parts.push(`${k}: ${v.length > 60 ? `${v.slice(0, 60)}…` : v}`);
    if (parts.join(", ").length > 300) break;
  }
  return clip(parts.join(", "), 300);
}

/** Which lead / task / message version a call was about: from the path, the query, the body, then the answer. */
function refsOf(path: string, query: URLSearchParams | null, body: Json | null, data: unknown) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : null;
  const inPath = (re: RegExp) => posInt(re.exec(path)?.[1]);
  const pick = (k: string) => posInt(body?.[k]) ?? posInt(query?.get(k)) ?? posInt(d?.[k]);
  const created = (re: RegExp) => (re.test(path) ? posInt(d?.id) : null);
  return {
    lead: inPath(/\/leads\/(\d+)/) ?? pick("lead_id") ?? posInt(query?.get("lead")) ?? created(/\/leads$|^create_lead$/),
    task: inPath(/\/tasks\/(\d+)/) ?? pick("task_id") ?? created(/\/tasks$|^create_task$/),
    version: inPath(/\/(?:message-versions|messages\/versions)\/(\d+)/) ?? pick("message_version_id") ?? created(/versions$|^create_message_version$/),
  };
}

export type ExecOpts = {
  via: "api" | "mcp";
  method: string;
  /** Path below /api/v1 (or the MCP tool name). */
  path: string;
  query?: URLSearchParams | null;
  /** Already authenticated (MCP authenticates once per HTTP request). */
  actor?: Actor;
  idempotencyKey?: string | null;
  /** Anything that is not a plain read. Decides the read / write label and whether an idempotency key applies. */
  write?: boolean;
  /** The request body when the caller already has it (MCP tool arguments). REST handlers report theirs when they read it. */
  body?: Json;
};

export async function execute(req: Request, o: ExecOpts, fn: (actor: Actor, note: (body: Json) => void) => Promise<unknown>): Promise<ApiResult> {
  const started = Date.now();
  const requestId = randomBytes(8).toString("hex");
  const runId = header(req, "x-run-id", 80);
  const write = o.write ?? o.method !== "GET";
  let actor: Actor | undefined = o.actor;
  let body: Json | null = o.body ?? null;
  let status = 200, json: Json, outcome = "ok", data: unknown, errCode: string | null = null, errText: string | null = null;
  try {
    actor = actor ?? (await getApiActor(req));
    actor = { ...actor, requestId, runId: runId ?? undefined };
    const key = write ? (o.idempotencyKey ?? header(req, "idempotency-key", 120)) : null;
    const seen = key ? await one("SELECT method,path,response FROM api_idempotency WHERE actor_id=? AND key=?", [actor.id, key]) : null;
    if (seen) {
      // The same key on the same call returns the first answer again and changes nothing. On a different call it is a mistake.
      if (seen.method !== o.method || seen.path !== o.path) throw new HttpError(409, `Idempotency-Key "${key}" was already used for ${seen.method} ${seen.path}. Use a new key for a different call.`, "idempotency_key_reused");
      json = { ...(JSON.parse(seen.response as string) as Json), request_id: requestId, replayed: true };
      // The handler does not run on a repeat, so read the body here: the log should still say what the repeat was about.
      if (!body) body = (await req.clone().json().then((j) => (j && typeof j === "object" && !Array.isArray(j) ? (j as Json) : null)).catch(() => null));
      data = json.data;
      outcome = "replayed";
    } else {
      data = publicShape(await fn(actor, (b) => { body = b; }));
      json = { ok: true, data, request_id: requestId };
      if (key) await run("INSERT OR IGNORE INTO api_idempotency (actor_id,key,method,path,response,request_id,created_at) VALUES (?,?,?,?,?,?,?)", [actor.id, key, o.method, o.path, JSON.stringify({ ok: true, data }), requestId, now()]);
    }
  } catch (e) {
    if (e instanceof HttpError) {
      const dups = (e as HttpError & { duplicates?: unknown }).duplicates;
      status = e.status;
      errCode = codeOf(e);
      errText = e.message;
      outcome = status >= 500 ? "error" : "refused";
      json = { ok: false, error: e.message, code: errCode, request_id: requestId, ...(dups ? { duplicates: dups } : {}) };
    } else {
      console.error(e);
      status = 500;
      errCode = "server_error";
      errText = e instanceof Error ? e.message : String(e);
      outcome = "error";
      json = { ok: false, error: "Server error.", code: errCode, request_id: requestId };
    }
  }
  // The log must never break or fail a call.
  try {
    const r = refsOf(o.path, o.query ?? null, body, data);
    await run(
      `INSERT INTO api_requests (request_id,at,actor_id,actor_name,key_id,key_label,run_id,via,method,path,query,kind,status,outcome,error_code,error,duration_ms,lead_id,task_id,message_version_id,request_body,result)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [requestId, new Date(started).toISOString(), actor?.id ?? null, actor?.name ?? null, actor?.keyId ?? null, actor?.keyLabel ?? null, runId, o.via, o.method, o.path,
        clip(o.query?.toString() || null, 500), write ? "write" : "read", status, outcome, errCode, clip(errText, 1000), Date.now() - started,
        r.lead, r.task, r.version, body ? clip(JSON.stringify(body), 2000) : null, outcome === "ok" || outcome === "replayed" ? summarize(data) : null],
    );
  } catch (e) {
    console.error("api request log failed:", e);
  }
  return { status, json, requestId };
}

/** Wraps a REST handler: bearer auth, JSON in/out, uniform errors with a code, request log, optional Idempotency-Key. */
export function route<P = Record<string, never>>(fn: (c: ApiCtx<P>) => Promise<unknown>) {
  return async (req: Request, { params }: { params: Promise<P> }) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, "") || "/";
    const r = await execute(req, { via: "api", method: req.method, path, query: url.searchParams }, async (actor, note) => {
      const body = async () => {
        const j = await req.json().catch(() => null);
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new HttpError(400, "Send a JSON object body (Content-Type: application/json).");
        note(j as Json);
        return j as Json;
      };
      return fn({ actor, req, params: await params, url, body });
    });
    return Response.json(r.json, { status: r.status, headers: { "X-Request-Id": r.requestId } });
  };
}
export const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Invalid id.");
  return n;
};
export const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
