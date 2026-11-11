import { HttpError, can, type Actor } from "./auth";
import { ALL_PERMISSIONS } from "./constants";
import { AGENT_GUIDE, GUIDE_VERSION } from "./agent-guide";
import { nextWork, changesSince } from "./service/agentwork";
import { checkIdentity } from "./service/dedupe";
import { listLeads, getLead, createLead, addContactDetailed, setStage, ATTENTION, type Attention } from "./service/leads";
import { recordActivity } from "./service/activities";
import { listTasksPaged, getTaskDetail, createTask, updateTask, completeTask, submitTask } from "./service/tasks";
import { createVersion, getVersion, listVersions, checkEligibility, confirmSend, reconcileSend, listDecisions } from "./service/sends";
import { recordReply, recordBounce } from "./service/inbound";
import { capacityFor } from "./service/capacity";
import { getLists } from "./service/lists";
import { assignableUsers } from "./service/users";
import { TOOL_LABELS } from "./tool-labels";

/**
 * The tools an AI agent gets over MCP (POST /api/mcp). Each one calls the SAME service function as its REST
 * endpoint, so permissions, safety rules and the change history are identical whichever door the agent uses.
 */

type Args = Record<string, unknown>;
type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
export type AgentTool = {
  name: string;
  /** Plain words, past tense: shown on the Agent activity page. */
  label: string;
  description: string;
  write: boolean;
  inputSchema: Schema;
  run: (actor: Actor, a: Args) => Promise<unknown>;
};

const S = { type: "string" } as const, I = { type: "integer" } as const, B = { type: "boolean" } as const;
const d = <T extends object>(t: T, description: string) => ({ ...t, description });
const obj = (properties: Record<string, unknown>, required: string[] = [], additionalProperties = false): Schema => ({ type: "object", properties, required, additionalProperties });
const int = (a: Args, k: string, required = true): number => {
  const v = a[k];
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  if (!required && (v === undefined || v === null || v === "")) return undefined as unknown as number;
  throw new HttpError(400, `${k}: a positive whole number is required.`);
};
const str = (a: Args, k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
const without = (a: Args, ...keys: string[]) => Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)));
const ISO = "ISO 8601 with Z or an offset, e.g. 2026-11-11T10:00:00+02:00";

const contactProps = { name: S, role: S, email: S, phone: S, linkedin: S, source_url: S, language: S, notes: S };

export const AGENT_TOOLS: AgentTool[] = [
  { name: "get_guide", label: "Read the agent guide", write: false, inputSchema: obj({}),
    description: "The agent briefing: ground rules, the only allowed sending workflow, timestamps, every endpoint. Read it at the start of a run; behaviour changed if `version` changed.",
    run: async () => ({ version: GUIDE_VERSION, format: "markdown", guide: AGENT_GUIDE }) },
  { name: "whoami", label: "Checked its own account and permissions", write: false, inputSchema: obj({}),
    description: "Who this key belongs to and what it is allowed to do.",
    run: async (actor) => ({ id: actor.id, username: actor.username, name: actor.name, role: actor.role, is_agent: !!actor.isAgent, key_label: actor.keyLabel ?? null, permissions: ALL_PERMISSIONS.filter((p) => can(actor, p)), guide_version: GUIDE_VERSION }) },
  { name: "next_work", label: "Asked what to do next", write: false, inputSchema: obj({ limit: d(I, "How many items (default 10, max 50)."), assignee: d(S, `Owner/Chief only: "all" for every assignee's work, or one user id. Default: yourself.`), action: d(S, "Only items whose next step is this: send, draft, work, wait or fix.") }),
    description: "START HERE. Your work list by urgency: overdue, due today, due tomorrow, then undated. A Chief who sends for the team passes assignee \"all\" and action \"send\". Each item has the task, lead, contacts, campaign, the message draft with its approvals, the send-eligibility check, and next_step {action, instruction}. action 'send' is the only one that allows contacting anyone.",
    run: (actor, a) => nextWork(actor, { limit: int(a, "limit", false), assignee: a.assignee === "all" ? "all" : a.assignee == null || a.assignee === "" ? undefined : Number(a.assignee), action: a.action == null ? null : String(a.action) }) },
  { name: "changes_since", label: "Asked what changed since last time", write: false, inputSchema: obj({ since: d(S, `${ISO}. Pass the next_since from your previous call. Default: the last 24 hours.`), limit: I }),
    description: "Everything that happened since your last run: drafts rejected or edited (with the reason), drafts approved, approvals decided, replies, bounces, opt-outs, and changes to your tasks. Oldest first.",
    run: (actor, a) => changesSince(actor, { since: str(a, "since"), limit: int(a, "limit", false) }) },
  { name: "get_lists", label: "Read the valid list values", write: false, inputSchema: obj({}),
    description: "Valid values for stage, market, segment, channel, industry, source, service, language, task_type, plus the people work can be assigned to.",
    run: async () => {
      const lists = await getLists();
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(lists)) out[k] = v.map((i) => ({ key: i.key, label: i.label, flag: i.flag }));
      out.users = await assignableUsers();
      return out;
    } },
  { name: "check_duplicate", label: "Checked for a duplicate before creating", write: false,
    inputSchema: obj({ company: S, website: S, emails: { type: "array", items: S }, phones: { type: "array", items: S }, profiles: { type: "array", items: S } }),
    description: "ALWAYS call before create_lead. decision: 'duplicate' = stop; 'review' = ambiguous, ask a Chief; 'clear' = safe to create. do_not_contact on a match means never contact.",
    run: async (actor, a) => {
      const { decision, matches } = await checkIdentity(actor, { company: a.company as string, website: a.website as string, emails: list(a.emails), phones: list(a.phones), profiles: list(a.profiles) });
      return { decision, matches };
    } },
  { name: "list_leads", label: "Listed leads", write: false,
    inputSchema: obj({ q: d(S, "Search company, website, country, contact name or email."), stage: S, campaign_id: I, attention: d({ type: "string", enum: [...ATTENTION] }, "unanswered = latest reply has no answer; quiet = open, no task, no activity for 7+ days."), page: I, page_size: I }),
    description: "Leads you can see (your own unless you have view-all), 50 per page.",
    run: (actor, a) => listLeads(actor, { q: str(a, "q"), stage: str(a, "stage"), campaign: int(a, "campaign_id", false), attention: (ATTENTION as readonly string[]).includes(String(a.attention)) ? (a.attention as Attention) : undefined, page: int(a, "page", false), pageSize: Math.min(int(a, "page_size", false) ?? 50, 200), includeDemo: false }) },
  { name: "get_lead", label: "Opened a lead", write: false, inputSchema: obj({ lead_id: I }, ["lead_id"]),
    description: "One lead with its contacts, tasks (live status) and full work history.",
    run: (actor, a) => getLead(actor, int(a, "lead_id")) },
  { name: "create_lead", label: "Created a lead", write: true,
    inputSchema: obj({ company: S, website: S, country: S, industry: S, market: S, segment: S, language: S, source: S, source_url: S, service: S, notes: S, stage: S, campaign_id: I, lead_date: d(S, "When the lead was really found (date or ISO). Never today's date for an old lead; omit if it was found now."), original_researcher: d({}, "Employee id, or \"unknown\"."),
      contacts: { type: "array", items: obj(contactProps, ["name"]) }, is_test: B, allow_duplicate: B }, ["company"]),
    description: "Create a lead (after check_duplicate says 'clear'), optionally inside a campaign and with contacts.",
    run: async (actor, a) => ({ id: await createLead(actor, a) }) },
  { name: "add_contact", label: "Added a contact", write: true, inputSchema: obj({ lead_id: I, ...contactProps }, ["lead_id"]),
    description: "Add a contact to an existing lead. The email is checked against every lead and against suppressed addresses first; a match creates nothing.",
    run: (actor, a) => addContactDetailed(actor, int(a, "lead_id"), without(a, "lead_id")) },
  { name: "record_activity", label: "Recorded work on a lead", write: true,
    inputSchema: obj({ lead_id: I, type: { type: "string", enum: ["research", "draft", "message", "reply", "outcome", "note"] }, title: S, body: S, channel: S, message_kind: { type: "string", enum: ["first_email", "follow_up", "other"] }, outcome: S, ref: S, url: S, contact_id: I, task_id: I, parent_id: I, occurred_at: d(S, ISO) }, ["lead_id", "type"]),
    description: "Record work that ALREADY happened (research notes, findings). For a sent email use record_send; for an inbound reply use record_reply.",
    run: (actor, a) => recordActivity(actor, int(a, "lead_id"), without(a, "lead_id")) },
  { name: "change_stage", label: "Changed a lead's stage", write: true, inputSchema: obj({ lead_id: I, stage: S, reason: d(S, "What actually happened.") }, ["lead_id", "stage", "reason"]),
    description: "Move a lead to another stage, with the real reason.",
    run: async (actor, a) => { await setStage(actor, int(a, "lead_id"), String(a.stage ?? ""), String(a.reason ?? "")); return { updated: true }; } },
  { name: "list_tasks", label: "Listed tasks", write: false, inputSchema: obj({ open: B, status: S, lead_id: I, q: S, page: I, page_size: I }),
    description: "Tasks with their live state (overdue | blocked | ready | planned | completed) and the reason. Prefer next_work for deciding what to do.",
    run: (actor, a) => listTasksPaged(actor, { open: a.open === true, status: str(a, "status"), lead: int(a, "lead_id", false), q: str(a, "q"), page: int(a, "page", false), pageSize: int(a, "page_size", false), includeDemo: false }) },
  { name: "get_task", label: "Opened a task", write: false, inputSchema: obj({ task_id: I }, ["task_id"]),
    description: "One task with notes, approvals and its live status.",
    run: (actor, a) => getTaskDetail(actor, int(a, "task_id")) },
  { name: "create_task", label: "Created a task", write: true,
    inputSchema: obj({ title: S, instructions: S, lead_id: I, assignee_id: I, task_type: S, campaign_id: I, channel: S, action_type: S, scheduled_at: d(S, `${ISO}, or YYYY-MM-DD for a date with no time.`), due_at: S, prep_status: S, blockers: S, is_test: B }, ["title"]),
    description: "Create a task. Dates go in scheduled_at / due_at, never in the title.",
    run: async (actor, a) => ({ id: await createTask(actor, a) }) },
  { name: "update_task", label: "Updated a task", write: true, inputSchema: obj({ task_id: I, status: S, progress_note: S, prep_status: S, blockers: S, scheduled_at: S, due_at: S, channel: S, action_type: S, campaign_id: I }, ["task_id"]),
    description: "Update a task: progress note, status, preparation status, blockers (managers: schedule, channel, campaign).",
    run: async (actor, a) => { await updateTask(actor, int(a, "task_id"), without(a, "task_id")); return { updated: true }; } },
  { name: "submit_task_for_approval", label: "Submitted work for approval", write: true, inputSchema: obj({ task_id: I, kind: { type: "string", enum: ["draft", "findings", "other"] }, title: S, content: S }, ["task_id", "kind", "content"]),
    description: "Send a task's result (findings, an offer, anything that is not an outreach message draft) for approval.",
    run: async (actor, a) => ({ approval_id: await submitTask(actor, int(a, "task_id"), without(a, "task_id")) }) },
  { name: "complete_task", label: "Completed a task", write: true, inputSchema: obj({ task_id: I, activity_id: d(I, "The recorded activity that proves the work happened (same lead)."), note: S }, ["task_id"]),
    description: "Close a task by hand. Send tasks close by themselves when the send is recorded; do not use this for them.",
    run: async (actor, a) => { await completeTask(actor, int(a, "task_id"), { note: str(a, "note") ?? null, activity_id: int(a, "activity_id", false) }); return { completed: true }; } },
  { name: "create_message_version", label: "Wrote a message draft", write: true,
    inputSchema: obj({ lead_id: I, contact_id: I, channel: S, campaign_id: I, task_id: I, subject: S, body: S, sender_id: I, sender_email: S, language: S }, ["lead_id", "channel", "campaign_id", "body"]),
    description: "Save a draft as a new immutable version. Any edit is a new version and voids earlier approvals. A draft is NOT a send: it waits for the Chief's review and the Owner's send approval.",
    run: async (actor, a) => { const r = await createVersion(actor, a); return { ...r, version_detail: await getVersion(actor, r.id) }; } },
  { name: "get_message_version", label: "Opened a message draft", write: false, inputSchema: obj({ message_version_id: I }, ["message_version_id"]),
    description: "One draft with its text, approvals and any Owner decisions (edited / rejected with the reason).",
    run: (actor, a) => getVersion(actor, int(a, "message_version_id")) },
  { name: "list_message_versions", label: "Listed message drafts", write: false,
    inputSchema: obj({ lead_id: I, campaign_id: I, status: { type: "string", enum: ["waiting_editorial", "waiting_send", "approved", "sent", "rejected", "superseded"] }, latest_only: B, page: I, limit: I }),
    description: "Drafts with status and eligibility.",
    run: (actor, a) => listVersions(actor, { lead_id: int(a, "lead_id", false), campaign_id: int(a, "campaign_id", false), status: str(a, "status"), latest_only: a.latest_only === true, page: int(a, "page", false), limit: int(a, "limit", false) }) },
  { name: "list_decisions", label: "Read the Owner's decisions on drafts", write: false, inputSchema: obj({ lead_id: I, limit: I }),
    description: "The Owner's edits and rejections of drafts, with the reason, the old text and the new text. Learn from these before writing the next draft.",
    run: (actor, a) => listDecisions(actor, { lead_id: int(a, "lead_id", false), limit: int(a, "limit", false) }) },
  { name: "check_send_eligibility", label: "Checked whether a message may be sent", write: false, inputSchema: obj({ message_version_id: I }, ["message_version_id"]),
    description: "MUST be eligible:true immediately before sending. If not, read reasons[] / codes[] and stop; never work around it.",
    run: (actor, a) => checkEligibility(actor, int(a, "message_version_id")) },
  { name: "record_send", label: "Recorded a sent message", write: true,
    inputSchema: obj({ event_id: d(S, "Unique and stable for this send; repeating it is safe."), message_version_id: I, sent_at: d(S, `The exact send time, ${ISO}.`), evidence: d(S, "Message-id or a link that proves the send.") }, ["event_id", "message_version_id", "sent_at", "evidence"]),
    description: "After you really sent the approved version in the browser. status RECORDED = done. SENT_CONFIRMED_CRM_PENDING = STOP, never resend; call reconcile_send until RECORDED.",
    run: (actor, a) => confirmSend(actor, a) },
  { name: "reconcile_send", label: "Finished recording a send", write: true, inputSchema: obj({ event_id: S }, ["event_id"]),
    description: "Finish the CRM record of a send that came back SENT_CONFIRMED_CRM_PENDING. Safe to repeat.",
    run: (actor, a) => reconcileSend(actor, String(a.event_id ?? "")) },
  { name: "record_reply", label: "Recorded a reply", write: true,
    inputSchema: obj({ lead_id: I, contact_id: I, received_at: d(S, ISO), from: S, subject: S, message_id: S, summary: S, classification: { type: "string", enum: ["interested", "soft", "not_interested", "out_of_office", "auto_reply", "other"] }, update_stage: B }, ["lead_id", "received_at", "classification"]),
    description: "Record an inbound reply. De-duplicated by message_id. not_interested moves the lead to Lost and cancels its follow-ups.",
    run: (actor, a) => recordReply(actor, a) },
  { name: "record_bounce", label: "Recorded a bounce", write: true, inputSchema: obj({ contact_id: I, message_id: S, bounced_at: d(S, ISO), reason: S, sender_id: I, sender_email: S }, ["contact_id", "bounced_at"]),
    description: "Record that a message bounced. The contact is blocked from future sends.",
    run: (actor, a) => recordBounce(actor, a) },
  { name: "get_capacity", label: "Checked today's sending capacity", write: false, inputSchema: obj({ date: d(S, "YYYY-MM-DD; default today.") }),
    description: "Per-sender daily sending capacity: used, reserved, remaining, and what is pushed to the next day.",
    run: (_actor, a) => capacityFor(str(a, "date")) },
];

for (const t of AGENT_TOOLS) TOOL_LABELS[t.name] = t.label;
export const toolByName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
