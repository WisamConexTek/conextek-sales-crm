// Run: npm test   (agent API: request log, runs, error codes, idempotency, /work/next, /changes, MCP, OpenAPI, dashboard loaders)
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const DB = "data/agent-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";
process.env.APP_TIMEZONE = "Asia/Hebron";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, all, run, ready } = await import("../src/lib/db");
  const U = await import("../src/lib/service/users");
  const C = await import("../src/lib/service/campaigns");
  const S = await import("../src/lib/service/sends");
  const AG = await import("../src/lib/service/agents");
  const L = await import("../src/lib/service/leads");
  const D = await import("../src/lib/service/dashboard");
  const { openApiSpec } = await import("../src/lib/openapi");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));

  const owner = await actorById(1, "session");
  const chief = await actorById((await U.createUser(owner, { username: "chief", name: "Chief", role: "chief", preset: "chief" })).id, "session");
  const novaId = (await U.createUser(owner, { username: "nova", name: "Agent Nova", role: "employee", preset: "outreach" })).id;
  await U.updateUserProfile(owner, novaId, { is_agent: true });
  const perms = JSON.parse((await one("SELECT permissions FROM users WHERE id=?", [novaId]))!.permissions as string) as string[];
  await U.setPermissions(owner, novaId, [...perms, "leads.create"], "custom");
  const novaKey = await U.createKey(owner, novaId, "nova laptop");
  const ownerKey = await U.createKey(owner, 1, "owner key");
  const camp = await C.createCampaign(chief, { name: "Agent Test", status: "active" });

  /** Call a real route handler exactly as Next would. */
  const call = async (method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string>; params?: Record<string, string>; file: string }) => {
    const mod = (await import(`../src/app/api/${o.file}/route`)) as Record<string, Handler>;
    const headers: Record<string, string> = { ...(o.key === null ? {} : { authorization: `Bearer ${o.key ?? novaKey}` }), ...(o.body ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) };
    const res = await mod[method](new Request(`http://crm.test/api/${path}`, { method, headers, body: o.body ? JSON.stringify(o.body) : undefined }), { params: Promise.resolve(o.params ?? {}) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const lastReq = async () => (await one("SELECT * FROM api_requests ORDER BY id DESC LIMIT 1"))!;
  const RUN = { "x-run-id": "nova-run-1" };

  console.log("Request log, identity, error codes");
  const noKey = await call("GET", "v1/me", { key: null, file: "v1/me" });
  ok(noKey.status === 401 && noKey.json.code === "unauthorized" && typeof noKey.json.request_id === "string", "no key: 401 with code unauthorized and a request_id");
  ok((await lastReq()).outcome === "refused" && (await lastReq()).actor_id === null, "a call without a valid key is logged too (refused, no actor)");
  const me = await call("GET", "v1/me", { headers: RUN, file: "v1/me" });
  ok(me.status === 200 && me.json.ok && me.json.data.is_agent === true && me.json.data.key_label === "nova laptop" && me.json.data.run_id === "nova-run-1", "GET /me shows the agent flag, the key label and the run id");
  ok(me.headers.get("x-request-id") === me.json.request_id, "the request id is also returned as the X-Request-Id header");
  const r1 = await lastReq();
  ok(r1.kind === "read" && r1.outcome === "ok" && r1.run_id === "nova-run-1" && r1.actor_id === novaId && r1.key_label === "nova laptop" && r1.path === "/me" && r1.request_id === me.json.request_id, "a read is logged with actor, key, run and path");

  const lead = await call("POST", "v1/leads", { headers: RUN, file: "v1/leads", body: { company: "Orbit Motors", website: "https://orbit.test", campaign_id: camp, contacts: [{ name: "Ola", email: "ola@orbit.test" }] } });
  const leadId = lead.json.data.id as number;
  const r2 = await lastReq();
  ok(lead.status === 200 && r2.kind === "write" && r2.lead_id === leadId && String(r2.request_body).includes("Orbit Motors") && String(r2.result).includes(`id: ${leadId}`), "a change is logged with what was sent, what came back and the lead it was about");
  const au = await one("SELECT * FROM audit_log WHERE action='create_lead' AND entity_id=?", [String(leadId)]);
  ok(au!.request_id === lead.json.request_id && au!.run_id === "nova-run-1" && Number(au!.key_id) > 0 && au!.via === "api", "the change history links the change to its request, run and key");
  const cid = (await one("SELECT id FROM contacts WHERE lead_id=?", [leadId]))!.id as number;

  const dup = await call("POST", "v1/leads", { headers: RUN, file: "v1/leads", body: { company: "Orbit Motors", website: "https://orbit.test" } });
  ok(dup.status === 409 && dup.json.code === "duplicate" && Array.isArray(dup.json.duplicates), "a duplicate is refused with code duplicate");
  const r3 = await lastReq();
  ok(r3.outcome === "refused" && r3.error_code === "duplicate" && /duplicate/i.test(r3.error) && r3.status === 409, "the refusal and its reason are logged");
  const nf = await call("GET", "v1/leads/99999", { headers: RUN, file: "v1/leads/[id]", params: { id: "99999" } });
  ok(nf.status === 404 && nf.json.code === "not_found", "not found carries code not_found");
  const bad = await call("POST", "v1/tasks", { headers: RUN, file: "v1/tasks", body: { title: "" } });
  ok(bad.status === 400 && bad.json.code === "invalid_input", "invalid input carries code invalid_input");

  console.log("Idempotency keys");
  const tBody = { title: "Send first email", lead_id: leadId, campaign_id: camp, channel: "email", action_type: "send_first_email", scheduled_at: new Date(Date.now() + 3600000).toISOString() };
  const t1 = await call("POST", "v1/tasks", { headers: { ...RUN, "idempotency-key": "task-orbit-1" }, file: "v1/tasks", body: tBody });
  const t2 = await call("POST", "v1/tasks", { headers: { ...RUN, "idempotency-key": "task-orbit-1" }, file: "v1/tasks", body: tBody });
  const taskId = t1.json.data.id as number;
  ok(t1.status === 200 && t2.status === 200 && t2.json.data.id === taskId && t2.json.replayed === true && !t1.json.replayed, "repeating a call with the same Idempotency-Key returns the first answer (replayed)");
  ok(Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE lead_id=?", [leadId]))!.n) === 1 && (await lastReq()).outcome === "replayed", "nothing was created twice, and the repeat is logged as a repeat");
  const reuse = await call("POST", "v1/leads", { headers: { ...RUN, "idempotency-key": "task-orbit-1" }, file: "v1/leads", body: { company: "Other Co" } });
  ok(reuse.status === 409 && reuse.json.code === "idempotency_key_reused", "the same key on a different call is refused");
  const other = await call("POST", "v1/tasks", { key: ownerKey, headers: { "idempotency-key": "task-orbit-1" }, file: "v1/tasks", body: { title: "Owner's own task" } });
  ok(other.status === 200 && !other.json.replayed, "idempotency keys are per account");

  console.log("GET /work/next");
  const next = async () => (await call("GET", "v1/work/next", { headers: RUN, file: "v1/work/next" })).json.data;
  let w = await next();
  let item = w.items.find((i: any) => i.task.id === taskId); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(w.assignee_id === novaId && item && item.next_step.action === "draft" && item.lead.company === "Orbit Motors" && item.contacts[0].email === "ola@orbit.test" && item.campaign.id === camp && item.message_version === null, "a send task with no draft: action draft, with lead, contact and campaign attached");
  const mv = await call("POST", "v1/message-versions", { headers: RUN, file: "v1/message-versions", body: { lead_id: leadId, contact_id: cid, channel: "email", campaign_id: camp, task_id: taskId, subject: "Hello Orbit", body: "First draft text." } });
  const v1 = mv.json.data.id as number;
  ok(mv.status === 200 && v1 > 0 && (await lastReq()).message_version_id === v1, "POST /message-versions (the new single path) creates the draft and is logged with its version");
  ok((await call("GET", `v1/message-versions/${v1}`, { headers: RUN, file: "v1/message-versions/[id]", params: { id: String(v1) } })).json.data.body === "First draft text.", "GET /message-versions/{id} reads it back");
  w = await next();
  item = w.items.find((i: any) => i.task.id === taskId); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(item.next_step.action === "wait" && item.message_version.id === v1 && item.message_version.body === "First draft text." && item.eligibility.eligible === false && item.eligibility.codes.includes("no_send_authorization"), "draft waiting for approval: action wait, with the text and the eligibility reasons");
  const self = await call("POST", "v1/authorizations", { headers: RUN, file: "v1/authorizations", body: { message_version_id: v1, kind: "send", permitted_action: "first_email" } });
  ok(self.status === 403 && self.json.code === "forbidden" && (await lastReq()).outcome === "refused", "an agent approving its own send is refused, and that attempt is on record");
  const sinceBefore = new Date(Date.now() - 1000).toISOString();
  await S.authorize(chief, { message_version_id: v1, kind: "editorial", permitted_action: "first_email" });
  await S.authorize(owner, { message_version_id: v1, kind: "send", permitted_action: "first_email" });
  w = await next();
  item = w.items.find((i: any) => i.task.id === taskId); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(item.next_step.action === "send" && item.eligibility.eligible === true && item.task.state === "ready" && w.items[0].task.id === taskId && item.message_version.authorizations.length === 2, "approved by Chief and Owner: action send, ready, first in the list");
  ok(/POST \/sends/.test(item.next_step.instruction) && item.next_step.instruction.includes(String(v1)), "the instruction names the exact version and the call to record the send");
  await throwsStatus(() => call("GET", "v1/work/next?assignee=1", { headers: RUN, file: "v1/work/next" }), 403, "an agent cannot read someone else's work list");

  console.log("GET /changes");
  const ch = (await call("GET", `v1/changes?since=${encodeURIComponent(sinceBefore)}`, { headers: RUN, file: "v1/changes" })).json.data;
  const types = ch.changes.map((c: any) => c.type) as string[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(types.includes("editorial_approved") && types.includes("send_approved") && ch.changes.every((c: any, i: number, a: any[]) => i === 0 || a[i - 1].at <= c.at), "approvals of my draft appear, oldest first"); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(ch.changes.find((c: any) => c.type === "send_approved").message_version_id === v1 && typeof ch.next_since === "string" && ch.has_more === false, "each change names its version; next_since is returned"); // eslint-disable-line @typescript-eslint/no-explicit-any
  // a second lead whose draft the Owner rejects
  const lead2 = (await call("POST", "v1/leads", { headers: RUN, file: "v1/leads", body: { company: "Pluto Cars", campaign_id: camp, contacts: [{ name: "Pat", email: "pat@pluto.test" }] } })).json.data.id as number;
  const cid2 = (await one("SELECT id FROM contacts WHERE lead_id=?", [lead2]))!.id as number;
  const v2 = (await call("POST", "v1/message-versions", { headers: RUN, file: "v1/message-versions", body: { lead_id: lead2, contact_id: cid2, channel: "email", campaign_id: camp, subject: "Hi", body: "Too pushy text." } })).json.data.id as number;
  await new Promise((r) => setTimeout(r, 15));
  await S.rejectVersion(owner, v2, "Too pushy. Shorter, no pricing.");
  const ch2 = (await call("GET", `v1/changes?since=${encodeURIComponent(ch.next_since)}`, { headers: RUN, file: "v1/changes" })).json.data;
  const rej = ch2.changes.find((c: any) => c.type === "draft_rejected"); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(rej && rej.message_version_id === v2 && /Too pushy/.test(rej.summary) && !ch2.changes.some((c: any) => c.type === "send_approved"), "since=next_since returns only what is new: the rejection, with its reason"); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok((await call("GET", "v1/changes?since=yesterday", { headers: RUN, file: "v1/changes" })).json.code === "invalid_input", "a since that is not a timestamp is refused");

  console.log("Sending through the API closes the loop");
  const sent = await call("POST", "v1/sends", { headers: RUN, file: "v1/sends", body: { event_id: "evt-orbit-1", message_version_id: v1, sent_at: new Date(Date.now() - 60000).toISOString(), evidence: "<m1@mail>" } });
  ok(sent.status === 200 && sent.json.data.status === "RECORDED", "the approved version is recorded as sent");
  w = await next();
  ok(!w.items.some((i: any) => i.task.id === taskId), "the finished task leaves the work list"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const undated = (await call("POST", "v1/tasks", { headers: RUN, file: "v1/tasks", body: { title: "Research with no date" } })).json.data.id as number;
  w = await next();
  item = w.items.find((i: any) => i.task.id === undated); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(item && item.next_step.action === "work" && item.task.state === "planned" && w.undated_open_tasks === 1, "a task with no date is still in the work list (it is work to do), after the dated ones");

  console.log("Work list: urgency order, holds that end, team view");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const T = await import("../src/lib/service/tasks");
  const { todayYmd, addDays } = await import("../src/lib/db");
  const mk = async (body: Record<string, unknown>) => (await call("POST", "v1/tasks", { headers: RUN, file: "v1/tasks", body })).json.data.id as number;
  for (let i = 0; i < 12; i++) await mk({ title: `Undated filler ${i}` });
  const tTomorrow = await mk({ title: "Due tomorrow", due_at: addDays(todayYmd(), 1) });
  const tToday = await mk({ title: "Due today", due_at: todayYmd() });
  const tLate = await mk({ title: "Late one", due_at: new Date(Date.now() - 2 * 86400000).toISOString() });
  w = await next();
  ok(w.items.length === 10 && w.items[0].task.id === tLate && w.items[0].task.urgency === "overdue" && w.items[1].task.id === tToday && w.items[1].task.urgency === "today" && w.items[2].task.id === tTomorrow && w.items[2].task.urgency === "tomorrow" && w.items.slice(3).every((i: any) => i.task.urgency === "undated"),
    "the first page is overdue, then due today, then due tomorrow, then undated, however many undated tasks there are");
  ok(w.by_urgency.overdue === 1 && w.by_urgency.today === 1 && w.by_urgency.tomorrow === 1 && w.by_urgency.undated === 13 && w.has_more === true && w.limit === 10, "the answer counts each urgency group and says there is more");
  ok((await call("GET", "v1/work/next?limit=50", { headers: RUN, file: "v1/work/next" })).json.data.items.length === 16, "limit goes up to 50");

  // a send task that was held by the daily cap and moved to tomorrow, with a note that forbids sending
  const lead3 = (await call("POST", "v1/leads", { headers: RUN, file: "v1/leads", body: { company: "Vega Trucks", campaign_id: camp, contacts: [{ name: "Vera", email: "vera@vega.test" }] } })).json.data.id as number;
  const cid3 = (await one("SELECT id FROM contacts WHERE lead_id=?", [lead3]))!.id as number;
  const heldTask = await mk({ title: "Send first email to Vega", instructions: "HOLD. This task grants no send permission.", lead_id: lead3, campaign_id: camp, channel: "email", action_type: "send_first_email", scheduled_at: new Date(Date.now() - 3600000).toISOString() });
  const v3 = (await call("POST", "v1/message-versions", { headers: RUN, file: "v1/message-versions", body: { lead_id: lead3, contact_id: cid3, channel: "email", campaign_id: camp, task_id: heldTask, subject: "Hello Vega", body: "Approved text." } })).json.data.id as number;
  await S.authorize(chief, { message_version_id: v3, kind: "editorial", permitted_action: "first_email" });
  await S.authorize(owner, { message_version_id: v3, kind: "send", permitted_action: "first_email" });
  await T.rescheduleTask(chief, heldTask, { scheduled_at: new Date(Date.now() + 86400000).toISOString(), reason: "daily send limit reached, moved to next day" });
  const all50 = async (q = "") => (await call("GET", `v1/work/next?limit=50${q}`, { headers: RUN, file: "v1/work/next" })).json.data;
  item = (await all50()).items.find((i: any) => i.task.id === heldTask);
  ok(item.task.held === true && /daily send limit/.test(item.task.hold_reason) && /^Held:/.test(item.task.reason), "while the hold runs, the task says it is held and why");
  // the day it was moved to arrives
  const nowIso = new Date(Date.now() - 60000).toISOString();
  await run("UPDATE tasks SET scheduled_at=?, due_at=? WHERE id=?", [nowIso, nowIso, heldTask]);
  item = (await all50()).items.find((i: any) => i.task.id === heldTask);
  ok(item.next_step.action === "send" && item.eligibility.eligible === true && item.task.held === false && item.task.hold_reason === null && !/Held/.test(String(item.task.reason)), "once that day arrives the hold ends by itself: no hold_reason, no Held text, next step send");
  ok(/daily send limit/.test(item.task.moved_reason) && !!item.task.moved_from && /out of date/.test(item.next_step.note), "the old reason stays as history, and an older do-not-send note in the instructions is flagged as out of date");
  const viaTasks = (await call("GET", `v1/tasks/${heldTask}`, { headers: RUN, file: "v1/tasks/[id]", params: { id: String(heldTask) } })).json.data;
  ok(viaTasks.hold_reason === null && viaTasks.held === false && /daily send limit/.test(viaTasks.moved_reason), "GET /tasks/{id} agrees");
  const onlySend = await all50("&action=send");
  ok(onlySend.items.length === 1 && onlySend.items[0].task.id === heldTask && onlySend.action === "send" && onlySend.has_more === false, "action=send returns only send-ready work");
  ok((await call("GET", "v1/work/next?action=fly", { headers: RUN, file: "v1/work/next" })).json.code === "invalid_input", "an unknown action is refused");

  const chiefKey = await U.createKey(owner, chief.id, "chief key");
  const noRec = (await call("GET", "v1/work/next?assignee=all&limit=50", { key: chiefKey, file: "v1/work/next" })).json.data.items.find((i: any) => i.task.id === heldTask);
  ok(noRec.next_step.action === "wait" && /message\.record_sent/.test(noRec.next_step.instruction), "someone who may not record sends is told so instead of being told to send");
  const chiefPerms = JSON.parse((await one("SELECT permissions FROM users WHERE id=?", [chief.id]))!.permissions as string) as string[];
  await U.setPermissions(owner, chief.id, [...chiefPerms, "message.record_sent"], "custom");
  const own = (await call("GET", "v1/work/next?limit=50", { key: chiefKey, file: "v1/work/next" })).json.data;
  ok(!own.items.some((i: any) => i.task.id === heldTask), "by default the Chief still sees only the Chief's own work");
  const team = (await call("GET", "v1/work/next?assignee=all&action=send&limit=50", { key: chiefKey, file: "v1/work/next" })).json.data;
  const ti = team.items.find((i: any) => i.task.id === heldTask);
  ok(team.assignee === "all" && ti && ti.next_step.action === "send" && ti.task.assignee.id === novaId && ti.task.assignee.name === "Agent Nova" && ti.message_version.id === v3, "assignee=all shows the Chief every assignee's send-ready work, with who it belongs to");
  ok((await call("GET", "v1/work/next?assignee=all&limit=50", { key: chiefKey, file: "v1/work/next" })).json.data.total_open === 18, "assignee=all without a filter lists the whole team's open work");
  const denied = await call("GET", "v1/work/next?assignee=all", { headers: RUN, file: "v1/work/next" });
  ok(denied.status === 403 && denied.json.code === "forbidden", "an agent who is not a manager cannot read the team list");
  /* eslint-enable @typescript-eslint/no-explicit-any */

  console.log("MCP server");
  const mcp = async (body: unknown, key: string | null = novaKey) => {
    const mod = (await import("../src/app/api/mcp/route")) as { POST: (r: Request) => Promise<Response>; GET: () => Response };
    const res = await mod.POST(new Request("http://crm.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-run-id": "nova-mcp-1", ...(key ? { "x-api-key": key } : {}) }, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  ok((await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null)).status === 401, "MCP without a key is refused");
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  ok(init.status === 200 && init.json.result.protocolVersion === "2025-03-26" && init.json.result.capabilities.tools && init.json.result.serverInfo.name === "conextek-crm", "initialize answers with the protocol version and tool capability (key in X-API-Key)");
  ok((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202, "a notification gets 202 and no body");
  const tl = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = tl.json.result.tools as { name: string; inputSchema: { type: string; properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean } }[];
  ok(tools.length >= 25 && tools.every((t) => t.inputSchema.type === "object") && tools.find((t) => t.name === "next_work")!.annotations.readOnlyHint === true, "tools/list returns the tools with JSON schemas; reads are marked read-only");
  ok("idempotency_key" in tools.find((t) => t.name === "create_lead")!.inputSchema.properties && !("idempotency_key" in tools.find((t) => t.name === "get_lead")!.inputSchema.properties), "tools that change data accept an idempotency_key");
  const who = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } });
  ok(who.json.result.isError === false && JSON.parse(who.json.result.content[0].text).is_agent === true, "tools/call whoami works");
  const r4 = await lastReq();
  ok(r4.via === "mcp" && r4.method === "TOOL" && r4.path === "whoami" && r4.run_id === "nova-mcp-1" && r4.actor_id === novaId && AG.stepLabel("TOOL", "whoami") === "Checked its own account and permissions", "a tool call is logged like any other step, in plain words");
  const nw = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "next_work", arguments: { limit: 5 } } });
  ok(nw.json.result.isError === false && Array.isArray(JSON.parse(nw.json.result.content[0].text).items), "tools/call next_work returns the work list");
  const refused = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_lead", arguments: { lead_id: 99999 } } });
  ok(refused.json.result.isError === true && JSON.parse(refused.json.result.content[0].text).code === "not_found" && (await lastReq()).outcome === "refused", "a refused tool call is a readable tool error with the same code, and is logged");
  const mt1 = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_task", arguments: { title: "Research Pluto", lead_id: lead2, idempotency_key: "mcp-task-1" } } });
  const mt2 = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_task", arguments: { title: "Research Pluto", lead_id: lead2, idempotency_key: "mcp-task-1" } } });
  ok(JSON.parse(mt1.json.result.content[0].text).id === JSON.parse(mt2.json.result.content[0].text).id && Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE lead_id=?", [lead2]))!.n) === 1 && (await lastReq()).lead_id === lead2, "an MCP change with idempotency_key is not done twice");
  ok((await mcp({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope", arguments: {} } })).json.error.code === -32602 && (await mcp({ jsonrpc: "2.0", id: 9, method: "resources/list" })).json.error.code === -32601, "unknown tool and unknown method are JSON-RPC errors");
  const batch = await mcp([{ jsonrpc: "2.0", id: 10, method: "ping" }, { jsonrpc: "2.0", id: 11, method: "tools/list" }]);
  ok(Array.isArray(batch.json) && batch.json.length === 2 && batch.json[0].id === 10, "a batch is answered as a batch");

  console.log("Reading the log");
  const mine = await AG.listRequests(await actorById(novaId, "api"), {});
  const everyone = await AG.listRequests(owner, {});
  ok(mine.rows.every((r) => r.actor_id === novaId) && everyone.total > mine.total && mine.has_more === false && mine.page_size === 100, "an agent sees only its own calls; the Owner sees all of them");
  const runRows = await AG.listRequests(owner, { run: "nova-run-1", oldestFirst: true, pageSize: 500 });
  ok(runRows.rows[0].path === "/me" && runRows.rows.length === runRows.total && runRows.rows.some((r) => r.step === "Asked what to do next") && runRows.rows.some((r) => r.step === "Recorded a sent message"), "one run reads as a timeline, in order, in plain words");
  ok((await AG.listRequests(owner, { outcome: "refused" })).rows.every((r) => r.outcome === "refused") && (await AG.listRequests(owner, { lead: leadId })).rows.every((r) => r.lead_id === leadId), "filters by result and by lead");
  const viaApi = await call("GET", "v1/requests?run_id=nova-run-1&outcome=refused", { headers: RUN, file: "v1/requests" });
  ok(viaApi.json.data.rows.length >= 3 && viaApi.json.data.rows.every((r: any) => r.outcome === "refused"), "GET /requests returns the same log over the API"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const sum = await AG.agentSummary(owner);
  const nova = sum.find((s) => s.id === novaId)!;
  ok(nova.isAgent && nova.steps > 10 && nova.changes >= 5 && nova.refused >= 4 && (await AG.listRuns(owner)).some((r) => r.runId === "nova-run-1" && r.refused >= 3), "the per-agent summary and the run list count steps, changes and refusals");
  ok((await AG.leadApiActivity(leadId)).length > 0 && (await AG.recentApiActivity(5)).steps.length === 5, "per-lead and dashboard views of the log load");
  await run("UPDATE api_requests SET run_id=run_id WHERE 1=0"); // the log is plain data: no triggers get in the way of housekeeping

  console.log("OpenAPI");
  const spec = openApiSpec("http://crm.test") as { openapi: string; paths: Record<string, Record<string, unknown>>; servers: { url: string }[] };
  const specOps = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f === "route.ts" ? [join(dir, f)] : []));
  const realOps = new Set<string>();
  for (const file of walk("src/app/api/v1")) {
    const p = "/" + file.replace(/^src\/app\/api\/v1\//, "").replace(/\/?route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}");
    if (p === "/openapi.json") continue;
    const mod = (await import(`../${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) if (typeof mod[m] === "function") realOps.add(`${m} ${p}`);
  }
  const alias = (o: string) => /^(POST|GET) \/messages\/versions(\/\{id\})?$/.test(o); // older paths kept for existing agents; documented under /message-versions
  const missing = [...realOps].filter((o) => !specOps.has(o) && !alias(o));
  const ghost = [...specOps].filter((o) => !realOps.has(o));
  ok(missing.length === 0, `every endpoint is described in the OpenAPI document${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  ok(ghost.length === 0, `the OpenAPI document describes no endpoint that does not exist${ghost.length ? ` (extra: ${ghost.join(", ")})` : ""}`);
  ok(spec.openapi === "3.1.0" && spec.servers[0].url === "http://crm.test/api/v1" && existsSync("src/app/api/v1/openapi.json/route.ts"), "it is served as OpenAPI 3.1 with the right base URL");
  const served = await ((await import("../src/app/api/v1/openapi.json/route")) as { GET: (r: Request) => Promise<Response> }).GET(new Request("http://crm.test/api/v1/openapi.json"));
  ok(served.status === 200 && Object.keys(((await served.json()) as { paths: object }).paths).length === Object.keys(spec.paths).length, "GET /openapi.json needs no key");

  console.log("Leads list and dashboard");
  const ll = await L.listLeads(owner, { campaign: camp });
  const ex = await L.leadListExtras(ll.rows.map((l) => l.id as number));
  ok(ll.total === 3 && ll.page_size === 50 && ll.has_more === false && ex.campaigns.get(leadId)![0].name === "Agent Test" && ex.nextTask.get(lead2)!.title === "Research Pluto" && !ex.nextTask.has(leadId), "the leads list shows each lead's campaign and its live next task");
  for (const [who2, label] of [[owner, "Owner"], [await actorById(novaId, "session"), "agent"]] as const) {
    const sc = D.dashScope(who2), p = D.resolvePeriod({});
    const [b, a, at, res, pl, f] = await Promise.all([D.loadBoard(who2, sc), D.loadActions(who2, sc), D.loadAttention(who2, sc), D.loadResults(who2, sc, p), D.loadPipeline(who2, sc, p), D.loadFeed(who2, sc)]);
    ok(typeof b.counts.overdue === "number" && typeof a.mineWaiting === "number" && at.unansweredCount === (await L.listLeads(who2, { attention: "unanswered" })).total && at.quietCount === (await L.listLeads(who2, { attention: "quiet" })).total
      && res.totals.first_emails === 1 && pl.stages.length > 0 && (label === "Owner" ? f.api!.steps.length > 0 && pl.campaigns!.find((c) => c.id === camp)!.firstEmails === 1 : f.api === null && pl.campaigns === null),
      `every dashboard section loads for the ${label}, and its counters equal the Leads filters`);
  }
  ok(Number((await all("SELECT id FROM api_requests WHERE outcome='error'")).length) === 0, "no call ended in a server error");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);

  async function throwsStatus(fn: () => Promise<{ status: number }>, status: number, name: string) {
    const r = await fn();
    ok(r.status === status, name);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
