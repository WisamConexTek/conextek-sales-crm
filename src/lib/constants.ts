export const ROLES = ["owner", "chief", "employee"] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "waiting_approval",
  "changes_requested",
  "approved",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  waiting_approval: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
};
export const OPEN_TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "waiting_approval",
  "changes_requested",
  "approved",
];

export const OUTCOMES = ["sent", "reply_received", "bounced", "no_response_yet", "opted_out"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  sent: "Sent",
  reply_received: "Reply received",
  bounced: "Bounced",
  no_response_yet: "No response yet",
  opted_out: "Opted out",
};

export const ACTIVITY_TYPES = ["research", "draft", "message", "reply", "outcome", "task", "status", "approval", "note"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_TYPE_LABEL: Record<string, string> = {
  research: "Research",
  draft: "Draft",
  message: "Message sent",
  reply: "Reply",
  outcome: "Outcome",
  task: "Task",
  status: "Stage change",
  approval: "Approval",
  note: "Note",
};
/** Types an employee can record directly (system types — task/status/approval — are written by their own actions). */
export const RECORDABLE_TYPES = ["research", "draft", "message", "reply", "outcome", "note"] as const;

export const MESSAGE_KINDS = ["first_email", "follow_up", "other"] as const;
export const MESSAGE_KIND_LABEL: Record<string, string> = {
  first_email: "First email",
  follow_up: "Follow-up",
  other: "Other message",
};

export const EMAIL_STATUSES = ["unknown", "ok", "bounced", "opted_out"] as const;
export const EMAIL_STATUS_LABEL: Record<string, string> = {
  unknown: "Unknown",
  ok: "OK",
  bounced: "Bounced",
  opted_out: "Opted out",
};

/* ---------------- Permissions ---------------- */

export const PERMISSIONS = {
  "leads.view_all": "View all leads (otherwise only leads assigned to them)",
  "leads.create": "Add new leads",
  "leads.edit": "Edit lead details and contacts",
  "leads.stage": "Record stage changes",
  "leads.import": "Import leads from CSV",
  "leads.export": "Export leads to CSV",
  "activity.record": "Record research, drafts, replies and notes",
  "message.record_sent": "Record that a message was actually sent",
  "tasks.create_own": "Create future tasks for themselves",
  "tasks.assign": "Create and assign tasks to others",
  "tasks.view_all": "View everyone's task queue",
  "approvals.submit": "Submit work for approval",
  "approvals.decide": "Decide approvals within delegated authority",
  "reports.view": "View reports and the dashboard for the whole team",
  "reports.export": "Export reports to CSV",
  "keys.manage": "Issue and revoke API keys for employees (never for the Owner or other Chiefs)",
  "campaigns.manage": "Create and edit campaigns, enrol and transfer leads between campaigns",
  "history.import": "Import historical records and correct original lead dates (Owner only unless granted)",
  "compliance.view": "Compliance monitor: reads everything (reports, plan, messages as sent, suppression list) and can change nothing",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const PRESETS: Record<string, { label: string; role: Role; perms: Permission[] }> = {
  owner: { label: "Owner (full access)", role: "owner", perms: ALL_PERMISSIONS },
  chief: {
    label: "Chief (manager)",
    role: "chief",
    perms: [
      "leads.view_all", "leads.create", "leads.edit", "leads.stage", "leads.import", "leads.export",
      "activity.record", "tasks.create_own", "tasks.assign", "tasks.view_all",
      "approvals.submit", "approvals.decide", "reports.view", "reports.export", "keys.manage", "campaigns.manage",
    ],
  },
  researcher: {
    label: "Researcher",
    role: "employee",
    perms: ["leads.create", "leads.edit", "leads.stage", "activity.record", "tasks.create_own", "approvals.submit"],
  },
  outreach: {
    label: "Outreach (can record sends)",
    role: "employee",
    perms: ["leads.edit", "leads.stage", "activity.record", "message.record_sent", "tasks.create_own", "approvals.submit"],
  },
  compliance: {
    label: "Compliance monitor (reads everything, changes nothing)",
    role: "employee",
    perms: ["leads.view_all", "tasks.view_all", "reports.view", "reports.export", "compliance.view"],
  },
  readonly: {
    label: "Read-only",
    role: "employee",
    perms: [],
  },
};

/* ---------------- Default editable lists ---------------- */

export type ListKind = "stage" | "market" | "segment" | "channel" | "industry" | "source" | "service" | "language" | "task_type";
export const LIST_KINDS: { kind: ListKind; title: string; hint: string }[] = [
  { kind: "stage", title: "Lead stages", hint: "Flags drive reports: Won / Lost / Meeting count in reports; Closed removes the lead from open pipeline." },
  { kind: "task_type", title: "Task / approval types", hint: "Choose who approves this type by default: Chief (delegated) or Wisam (owner only)." },
  { kind: "market", title: "Target markets (geography)", hint: "Countries/regions only. Customer types such as dealers or exporters belong in Customer segments." },
  { kind: "segment", title: "Customer segments", hint: "Who the customer is (e.g. NC dealers, Chinese exporters) — separate from the geographic market." },
  { kind: "channel", title: "Channels", hint: "" },
  { kind: "industry", title: "Industries", hint: "" },
  { kind: "source", title: "Lead sources", hint: "" },
  { kind: "service", title: "Services of interest", hint: "" },
  { kind: "language", title: "Languages", hint: "" },
];

export const DEFAULT_LISTS: Record<ListKind, { key: string; label: string; flag?: string }[]> = {
  stage: [
    { key: "new", label: "New" },
    { key: "researching", label: "Researching" },
    { key: "ready", label: "Ready for outreach" },
    { key: "contacted", label: "Contacted" },
    { key: "replied", label: "Replied", flag: "replied" },
    { key: "interested", label: "Interested" },
    { key: "meeting", label: "Meeting", flag: "meeting" },
    { key: "trial", label: "Trial" },
    { key: "won", label: "Won", flag: "won" },
    { key: "lost", label: "Lost", flag: "lost" },
    { key: "not_a_fit", label: "Not a fit", flag: "closed" },
  ],
  task_type: [
    { key: "research", label: "Research", flag: "chief" },
    { key: "first_email_draft", label: "First email draft", flag: "chief" },
    { key: "follow_up_draft", label: "Follow-up draft", flag: "chief" },
    { key: "reply_draft", label: "Reply to a lead", flag: "chief" },
    { key: "pricing_offer", label: "Pricing / offer", flag: "wisam" },
    { key: "new_market", label: "New market / strategy change", flag: "wisam" },
    { key: "other", label: "Other", flag: "chief" },
  ],
  market: [
    { key: "china", label: "China" },
    { key: "uae", label: "UAE" },
    { key: "ksa", label: "Saudi Arabia" },
    { key: "qatar", label: "Qatar" },
    { key: "kuwait", label: "Kuwait" },
    { key: "bahrain", label: "Bahrain" },
    { key: "oman", label: "Oman" },
    { key: "other", label: "Other" },
  ],
  segment: [
    { key: "nc_dealers", label: "NC dealers" },
    { key: "chinese_exporters", label: "Chinese exporters" },
  ],
  channel: [
    { key: "email", label: "Email" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "whatsapp", label: "WhatsApp" },
    { key: "phone", label: "Phone" },
    { key: "other", label: "Other" },
  ],
  industry: [
    { key: "automotive", label: "Automotive" },
    { key: "manufacturing_export", label: "Manufacturing / Export" },
    { key: "other", label: "Other" },
  ],
  source: [
    { key: "canton_fair", label: "Canton Fair catalogs" },
    { key: "cars_com", label: "Cars.com" },
    { key: "hunter", label: "Hunter" },
    { key: "apollo", label: "Apollo" },
    { key: "manual_research", label: "Manual research" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "referral", label: "Referral" },
    { key: "inbound", label: "Inbound" },
    { key: "csv_import", label: "CSV import" },
    { key: "other", label: "Other" },
  ],
  service: [
    { key: "customer_care", label: "Customer care" },
    { key: "after_hours_bdc", label: "After-hours / BDC support" },
    { key: "sales_representation", label: "Sales representation" },
  ],
  language: [
    { key: "en", label: "English" },
    { key: "ar", label: "Arabic" },
  ],
};

/** Lead filters for "needs a person". Kept here (a module with no imports) because it is read while other modules are still loading. */
export const ATTENTION = ["unanswered", "quiet", "warm_idle"] as const;
export type Attention = (typeof ATTENTION)[number];

/* ---------------- Follow-up sequences ---------------- */
export const REPLY_CLASSES = ["interested", "soft", "not_now", "not_interested", "referral", "unsubscribe", "out_of_office", "auto_reply", "other"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];
export const REPLY_CLASS_LABEL: Record<string, string> = {
  interested: "Interested", soft: "Has questions", not_now: "Not now", not_interested: "Not interested", referral: "Referral / wrong person",
  unsubscribe: "Unsubscribe", out_of_office: "Out of office", auto_reply: "Auto-reply", other: "Other",
};
/** Roles that own a kind of work. The Owner maps each to a user in Settings. */
export const WORK_ROLES = ["writer", "hunter", "inbox", "linkedin", "chief", "compliance", "owner"] as const;
export type WorkRole = (typeof WORK_ROLES)[number];
export const WORK_ROLE_LABEL: Record<WorkRole, string> = { writer: "Outreach Writer", hunter: "Lead Hunter", inbox: "Inbox Manager", linkedin: "LinkedIn Manager", chief: "Chief", compliance: "Quality Coach", owner: "Owner" };
export const STEP_CODES = ["E1", "FU1", "FU2", "FU3", "FINAL", "LI_CONNECT", "DM1", "DM2", "DM3", "CALL", "OTHER"] as const;
/** Short label for the Tasks table, and the longer one used on the Leads page. */
export const STEP_SHORT: Record<string, string> = { E1: "Email 1", FU1: "FU1", FU2: "FU2", FU3: "FU3", FINAL: "Final email", LI_CONNECT: "LinkedIn connect", DM1: "LinkedIn DM1", DM2: "LinkedIn DM2", DM3: "LinkedIn DM3", CALL: "Call", OTHER: "Other" };
export const STEP_LONG: Record<string, string> = { E1: "First email", FU1: "Follow-up email 1", FU2: "Follow-up email 2", FU3: "Follow-up email 3", FINAL: "Final email", LI_CONNECT: "LinkedIn connect", DM1: "LinkedIn DM 1", DM2: "LinkedIn DM 2", DM3: "LinkedIn DM 3", CALL: "Call", OTHER: "Next step" };
export const STEP_ACTION: Record<string, string> = { E1: "send_first_email", FU1: "send_follow_up_1", FU2: "send_follow_up_2", FU3: "send_follow_up_3", FINAL: "send_final_email", LI_CONNECT: "send_linkedin_connect", DM1: "send_linkedin_dm_1", DM2: "send_linkedin_dm_2", DM3: "send_linkedin_dm_3", CALL: "call", OTHER: "other" };
export const TASK_DISPLAY_TYPES = ["Email 1", "FU1", "FU2", "FU3", "Email 1 draft", "FU draft", "Reply FU", "Reply", "Research", "LinkedIn connect", "LinkedIn DM1", "LinkedIn DM2", "LinkedIn DM3", "Review", "Revisit", "Pricing / offer", "Other"] as const;
/** Mail providers whose domain says nothing about the company. Never used to match two contacts to one company. */
export const FREE_MAIL = ["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "163.com", "126.com", "qq.com", "foxmail.com", "sina.com", "sina.cn", "sohu.com", "yeah.net", "aliyun.com", "139.com"];
