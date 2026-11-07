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
  "history.import": "Import historical records and correct original lead dates (Owner only unless granted)",
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
      "approvals.submit", "approvals.decide", "reports.view", "reports.export", "keys.manage",
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
