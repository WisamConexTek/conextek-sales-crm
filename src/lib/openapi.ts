import { GUIDE_VERSION } from "./agent-guide";

/**
 * OpenAPI 3.1 description of /api/v1, served at GET /api/v1/openapi.json so agents and tools can load the API
 * without reading prose. Kept as one table: [method, path, tag, summary, query params, body fields].
 * A field ending in "*" is required. Behaviour and safety rules live in the guide (GET /api/v1/guide).
 */
type Row = [method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, tag: string, summary: string, query?: string[], body?: string[]];

const E: Row[] = [
  ["GET", "/guide", "Start here", "The agent briefing (markdown). Re-read at the start of each run; `version` changes when behaviour changes."],
  ["GET", "/me", "Start here", "Who this key belongs to and what it may do."],
  ["GET", "/work/next", "Start here", "What to do now: the work list with lead, contacts, draft, approvals, eligibility and one next_step per item.", ["limit", "assignee"]],
  ["GET", "/changes", "Start here", "What happened since your last run: decisions on drafts, approvals, replies, bounces, task changes.", ["since", "limit"]],
  ["GET", "/lists", "Start here", "Valid values: stages, markets, segments, channels, task types, sources, services, users."],
  ["GET", "/requests", "Start here", "The API request log (your own calls; Owner/Chief: everyone's).", ["actor", "outcome", "kind", "run_id", "lead_id", "task_id", "q", "from", "to", "page", "page_size"]],

  ["POST", "/duplicates/check", "Leads", "Check identity before creating anything. decision: duplicate | review | clear.", [], ["company", "website", "emails[]", "phones[]", "profiles[]"]],
  ["GET", "/duplicates/reviews", "Leads", "Duplicate reviews waiting for a Chief.", ["status"]],
  ["POST", "/duplicates/reviews", "Leads", "Ask a Chief to decide an ambiguous match.", [], ["existing_lead_id*", "proposed*"]],
  ["PATCH", "/duplicates/reviews/{id}", "Leads", "Chief decides a duplicate review.", [], ["decision*", "note"]],
  ["GET", "/leads", "Leads", "Leads you can see.", ["q", "stage", "market", "segment", "owner", "channel", "campaign_id", "attention", "page", "page_size", "include_test", "include_historical"]],
  ["POST", "/leads", "Leads", "Create a lead, optionally in a campaign and with contacts.", [], ["company*", "website", "country", "industry", "market", "segment", "language", "source", "source_url", "service", "notes", "stage", "owner_id", "campaign_id", "lead_date", "original_researcher", "contacts[]", "is_test", "allow_duplicate"]],
  ["GET", "/leads/duplicates", "Leads", "Simple duplicate lookup by company / website / email.", ["company", "website", "email"]],
  ["GET", "/leads/{id}", "Leads", "One lead with contacts, tasks and full history."],
  ["PATCH", "/leads/{id}", "Leads", "Update lead fields.", [], ["company", "website", "country", "industry", "market", "segment", "language", "source", "service", "notes", "owner_id", "lead_date", "is_test", "historical_only"]],
  ["POST", "/leads/{id}/stage", "Leads", "Change the stage, with the real reason.", [], ["stage*", "reason*"]],
  ["POST", "/leads/{id}/activities", "Leads", "Record work that already happened (research, note, draft...).", [], ["type*", "title", "body", "channel", "message_kind", "outcome", "ref", "url", "contact_id", "task_id", "parent_id", "occurred_at"]],
  ["POST", "/leads/{id}/contacts", "Leads", "Add a contact (global email dedupe and suppression check first).", [], ["name", "role", "email", "phone", "linkedin", "source_url", "language", "notes"]],
  ["GET", "/leads/{id}/campaigns", "Leads", "The lead's campaign memberships."],
  ["POST", "/leads/{id}/campaigns", "Leads", "Enrol in, or transfer to, a campaign.", [], ["campaign_id*", "transfer_from_campaign_id", "note"]],
  ["DELETE", "/leads/{id}/campaigns", "Leads", "Remove from a campaign.", ["campaign_id"]],
  ["GET", "/contacts/{id}", "Leads", "One contact."],
  ["PATCH", "/contacts/{id}", "Leads", "Update a contact. Contacts are never deleted: use status.", [], ["name", "role", "email", "phone", "source_url", "language", "notes", "status"]],

  ["GET", "/schedule", "Tasks", "Work on a day or range with live state.", ["view", "date", "from", "to", "employee", "project", "campaign", "channel", "state", "include_test"]],
  ["GET", "/tasks", "Tasks", "Tasks with live state. Pass page to get {rows, page, page_size, has_more}.", ["assignee", "status", "lead", "open", "overdue", "q", "page", "page_size", "include_test"]],
  ["POST", "/tasks", "Tasks", "Create a task.", [], ["title*", "instructions", "lead_id", "assignee_id", "task_type", "campaign_id", "channel", "action_type", "scheduled_at", "due_at", "prep_status", "blockers", "approval", "is_test"]],
  ["GET", "/tasks/{id}", "Tasks", "One task with notes and approvals."],
  ["PATCH", "/tasks/{id}", "Tasks", "Update a task.", [], ["status", "progress_note", "prep_status", "blockers", "scheduled_at", "due_at", "channel", "action_type", "campaign_id"]],
  ["POST", "/tasks/{id}/submit", "Tasks", "Submit work for approval.", [], ["kind*", "title", "content*"]],
  ["POST", "/tasks/{id}/complete", "Tasks", "Close a task by hand.", [], ["activity_id", "note"]],
  ["POST", "/tasks/{id}/reschedule", "Tasks", "Owner/Chief: hold a task to a later slot with a reason.", [], ["scheduled_at*", "reason*"]],
  ["POST", "/tasks/reconcile", "Tasks", "Owner/Chief: bring tasks in line with approvals and sends."],
  ["GET", "/approvals", "Tasks", "Task approvals.", ["status", "requires"]],
  ["GET", "/approvals/{id}", "Tasks", "One approval."],
  ["POST", "/approvals/{id}/decision", "Tasks", "Decide an approval.", [], ["decision*", "comment"]],
  ["POST", "/approvals/{id}/escalate", "Tasks", "Chief escalates to the Owner.", [], ["comment"]],

  ["POST", "/message-versions", "Sending", "Save a draft as a new immutable version (also at /messages/versions).", [], ["lead_id*", "contact_id", "channel*", "campaign_id*", "task_id", "subject", "body*", "sender_id", "sender_email", "language"]],
  ["GET", "/message-versions", "Sending", "Drafts with status and eligibility.", ["campaign_id", "lead_id", "sender_id", "status", "latest_only", "limit", "page"]],
  ["GET", "/message-versions/{id}", "Sending", "One draft: text, approvals, decisions (also at /messages/versions/{id})."],
  ["GET", "/message-versions/{id}/authorizations", "Sending", "Who authorized exactly which version."],
  ["POST", "/messages/versions/{id}/edit", "Sending", "Owner edits a draft: saved as a new version.", [], ["subject", "body*", "sender_id", "note"]],
  ["POST", "/messages/versions/{id}/reject", "Sending", "Owner rejects a draft with a reason.", [], ["reason*"]],
  ["GET", "/messages/decisions", "Sending", "Edits and rejections with reasons: learn from these.", ["lead_id", "limit"]],
  ["POST", "/authorizations", "Sending", "Chief: editorial review. Owner (or delegate): send approval.", [], ["message_version_id*", "kind*", "permitted_action*", "note"]],
  ["POST", "/authorizations/bulk", "Sending", "Owner approves several sends.", [], ["items[]*"]],
  ["GET", "/authorizations/pending", "Sending", "Drafts waiting for send approval."],
  ["DELETE", "/authorizations/{id}", "Sending", "Withdraw an approval."],
  ["GET", "/sends/eligibility", "Sending", "Must be eligible:true immediately before sending.", ["message_version_id"]],
  ["POST", "/sends", "Sending", "Record a send that really happened. Idempotent by event_id.", [], ["event_id*", "message_version_id*", "sent_at*", "evidence*"]],
  ["GET", "/sends", "Sending", "Recorded sends.", ["status"]],
  ["POST", "/sends/{event_id}/reconcile", "Sending", "Finish recording a SENT_CONFIRMED_CRM_PENDING send. Safe to repeat."],
  ["GET", "/capacity", "Sending", "Per-sender daily capacity.", ["date"]],
  ["GET", "/senders", "Sending", "Sending mailboxes."],
  ["GET", "/senders/{id}", "Sending", "One sender."],
  ["GET", "/senders/health", "Sending", "Per-sender 7-day health."],
  ["GET", "/senders/log", "Sending", "Who paused / resumed / changed a sender.", ["sender_id"]],
  ["POST", "/senders", "Sending", "Owner: add a sender.", [], ["email*", "display_name*", "title", "domain", "languages[]", "campaign_ids[]", "daily_cap", "active"]],
  ["PATCH", "/senders/{id}", "Sending", "Owner: change a sender.", [], ["display_name", "title", "languages[]", "campaign_ids[]", "daily_cap", "active"]],
  ["PUT", "/senders/{id}/warmup", "Sending", "Owner: replace the warm-up schedule.", [], ["steps[]*"]],
  ["POST", "/senders/{id}/pause", "Sending", "Owner: pause a sender.", [], ["reason*"]],
  ["POST", "/senders/{id}/resume", "Sending", "Owner: resume a sender.", [], ["reason*"]],

  ["POST", "/replies", "Inbound", "Record an inbound reply. De-duplicated by message_id.", [], ["lead_id*", "contact_id", "received_at*", "from", "subject", "message_id", "summary", "classification*", "update_stage"]],
  ["POST", "/bounces", "Inbound", "Record a bounce: the contact is blocked.", [], ["contact_id*", "message_id", "bounced_at*", "reason", "sender_id", "sender_email"]],
  ["POST", "/complaints", "Inbound", "Record a spam complaint: contact opted out, sender paused.", [], ["sender_id", "sender_email", "lead_id", "contact_id", "message_id", "occurred_at", "note"]],

  ["GET", "/campaigns", "Campaigns", "Campaigns."],
  ["POST", "/campaigns", "Campaigns", "Create a campaign.", [], ["name*", "owner_id", "target_markets", "objective", "status"]],
  ["GET", "/campaigns/{id}", "Campaigns", "One campaign."],
  ["PATCH", "/campaigns/{id}", "Campaigns", "Update a campaign.", [], ["name", "owner_id", "target_markets", "objective", "status"]],
  ["GET", "/campaigns/report", "Campaigns", "Campaign report (managers).", ["campaign_id", "sender_id"]],
  ["GET", "/campaigns/unassigned", "Campaigns", "Leads in no campaign.", ["page", "page_size"]],
  ["GET", "/projects", "Campaigns", "Projects."],
  ["GET", "/channels", "Campaigns", "Channels."],

  ["GET", "/reports", "Reports", "Numbers by event date. all=1 | from&to | period&at.", ["all", "from", "to", "period", "at", "employee", "sender"]],
  ["GET", "/settings/capacity", "Settings", "Capacity settings."],
  ["PUT", "/settings/capacity", "Settings", "Owner: campaign priority and default cap.", [], ["priority[]", "daily_cap"]],
  ["GET", "/settings/send-delegation", "Settings", "Who may approve sends besides the Owner."],
  ["PUT", "/settings/send-delegation", "Settings", "Owner: delegate send approval to one Chief.", [], ["user_id"]],

  ["POST", "/import/history", "Historical import", "Needs history.import. Dry run unless commit:true. Record shapes: see /api-docs.", [], ["commit"]],
  ["POST", "/import/lead-dates", "Historical import", "Correct original lead dates.", [], ["commit"]],
  ["POST", "/import/reconcile-activities", "Historical import", "Attach external ids to existing activities.", [], ["commit"]],
  ["POST", "/import/activity-times", "Historical import", "Correct event times of existing activities.", [], ["commit"]],
];

const opId = (m: string, p: string) => `${m.toLowerCase()}${p.replace(/\{(\w+)\}/g, "_by_$1").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+$/, "")}`;

export function openApiSpec(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, tag, summary, query = [], body] of E) {
    const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: m[1] === "event_id" ? "string" : "integer" } }));
    const queryParams = query.map((name) => ({ name, in: "query", required: false, schema: { type: "string" } }));
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const raw of body ?? []) {
      const req = raw.endsWith("*");
      const f = req ? raw.slice(0, -1) : raw;
      const isList = f.endsWith("[]");
      const name = isList ? f.slice(0, -2) : f;
      props[name] = isList ? { type: "array", items: {} } : {};
      if (req) required.push(name);
    }
    const write = method !== "GET";
    (paths[path] ??= {})[method.toLowerCase()] = {
      operationId: opId(method, path), tags: [tag], summary,
      parameters: [
        ...pathParams, ...queryParams,
        { $ref: "#/components/parameters/RunId" },
        ...(write ? [{ $ref: "#/components/parameters/IdempotencyKey" }] : []),
      ],
      ...(body ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: props, ...(required.length ? { required } : {}) } } } } } : {}),
      responses: {
        "200": { description: "Success", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
        default: { description: "Refused or failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ConexTek Sales CRM API", version: GUIDE_VERSION,
      description: "The CRM records work; it never sends anything itself. Read GET /guide for the rules and the only allowed sending workflow. Start a run with GET /work/next and GET /changes. An MCP server with the same abilities is at POST /api/mcp.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key issued in Settings. Also accepted as the X-API-Key header." } },
      parameters: {
        RunId: { name: "X-Run-Id", in: "header", required: false, schema: { type: "string", maxLength: 80 }, description: "One id per agent run. Groups your calls into one timeline on the Agent activity page." },
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 120 }, description: "Repeat the same key when retrying this exact call: the first answer is returned again (replayed:true) and nothing is done twice." },
      },
      schemas: {
        Ok: { type: "object", required: ["ok", "data", "request_id"], properties: { ok: { const: true }, data: {}, request_id: { type: "string" }, replayed: { type: "boolean" } } },
        Error: {
          type: "object", required: ["ok", "error", "code", "request_id"],
          properties: {
            ok: { const: false }, error: { type: "string", description: "Plain-language reason." },
            code: { type: "string", description: "Stable reason: invalid_input | unauthorized | forbidden | not_found | conflict | duplicate | idempotency_key_reused | too_large | server_error." },
            request_id: { type: "string" }, duplicates: { type: "array", items: {} },
          },
        },
      },
    },
  };
}
