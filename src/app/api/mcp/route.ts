import { execute } from "@/lib/api";
import { getApiActor, HttpError, type Actor } from "@/lib/auth";
import { AGENT_TOOLS, toolByName } from "@/lib/agent-tools";
import { GUIDE_VERSION } from "@/lib/agent-guide";

/**
 * MCP server (Model Context Protocol, Streamable HTTP transport, stateless): POST /api/mcp with the same API key
 * (Authorization: Bearer <key>, or X-API-Key). An MCP client then sees the CRM as a set of tools; no HTTP code needed.
 * Every tool call runs through the same door as the REST API (src/lib/api.ts): same permissions, same safety rules,
 * same request log (shown on the Agent activity page), same change history.
 */
export const dynamic = "force-dynamic";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const INSTRUCTIONS =
  "ConexTek Sales CRM. The CRM records work; it never sends anything itself. Start every run with get_guide (once) and next_work. " +
  "Only contact someone when next_work says action 'send', and only with that exact approved version; then call record_send. " +
  "Use changes_since to learn what was approved, edited or rejected since your last run. Never work around a refusal.";

async function handle(req: Request, actor: Actor, m: Rpc) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return ok(m.id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "conextek-crm", title: "ConexTek Sales CRM", version: GUIDE_VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: AGENT_TOOLS.map((t) => ({
          name: t.name, title: t.label, description: t.description,
          inputSchema: t.write ? { ...t.inputSchema, properties: { ...t.inputSchema.properties, idempotency_key: { type: "string", description: "Optional. Repeat the same key when you retry this exact call: the first answer is returned again and nothing is done twice." } } } : t.inputSchema,
          annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = toolByName.get(String(p.name ?? ""));
      if (!tool) return fail(m.id, -32602, `Unknown tool: ${String(p.name ?? "")}`);
      const raw = (p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? p.arguments : {}) as Record<string, unknown>;
      const { idempotency_key, ...args } = raw;
      const r = await execute(req, { via: "mcp", method: "TOOL", path: tool.name, actor, write: tool.write, idempotencyKey: typeof idempotency_key === "string" && idempotency_key ? idempotency_key.slice(0, 120) : null, body: args },
        async (a) => tool.run(a, args));
      // A refusal is a normal tool result the model can read and act on (isError), not a protocol failure.
      return ok(m.id, { content: [{ type: "text", text: JSON.stringify(r.json.ok ? r.json.data ?? null : r.json) }], isError: !r.json.ok });
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method ?? ""}`);
  }
}

export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await getApiActor(req);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "Unauthorized.";
    return Response.json(fail(null, -32001, msg), { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const payload = (await req.json().catch(() => null)) as Rpc | Rpc[] | null;
  if (!payload || typeof payload !== "object") return Response.json(fail(null, -32700, "Parse error: send a JSON-RPC 2.0 message."), { status: 400 });
  const msgs = Array.isArray(payload) ? payload : [payload];
  const out: unknown[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || typeof m.method !== "string") { out.push(fail((m as Rpc)?.id, -32600, "Invalid request.")); continue; }
    if (m.id === undefined || m.id === null) continue; // a notification (e.g. notifications/initialized): nothing to answer
    try {
      out.push(await handle(req, actor, m));
    } catch (e) {
      console.error(e);
      out.push(fail(m.id, -32603, "Internal error."));
    }
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(payload) ? out : out[0]);
}

const notAllowed = () => Response.json(fail(null, -32000, "This MCP server is stateless: use POST."), { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
