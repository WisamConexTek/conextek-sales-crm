// Versioned migrations. Append new entries; never edit old ones.
export const MIGRATIONS: string[] = [
  `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','chief','employee')),
  preset TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Editable lists: stage, market, channel, industry, source, service, language, task_type
-- "key" is stable (referenced by records); "label" can be renamed freely.
-- flag: stages -> won|lost|closed|meeting|replied ; task_type -> chief|wisam (who approves by default)
CREATE TABLE lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  flag TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, key)
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  industry TEXT,
  country TEXT,
  market TEXT,
  language TEXT,
  source TEXT,
  source_url TEXT,
  owner_id INTEGER REFERENCES users(id),
  stage TEXT NOT NULL,
  service TEXT,
  notes TEXT,
  next_action TEXT,
  next_due_at TEXT,
  last_activity_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_leads_owner ON leads(owner_id);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_domain ON leads(domain);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  other_social TEXT,
  email_status TEXT NOT NULL DEFAULT 'unknown' CHECK (email_status IN ('unknown','ok','bounced','opted_out')),
  notes TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_lead ON contacts(lead_id);
CREATE INDEX idx_contacts_email ON contacts(email);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  instructions TEXT,
  task_type TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','waiting_approval','changes_requested','approved','completed','cancelled')),
  approval_from TEXT CHECK (approval_from IN ('chief','wisam')),
  progress_note TEXT,
  change_request TEXT,
  due_at TEXT,
  completed_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_lead ON tasks(lead_id);

-- The chronological work history of a lead.
-- type: research | draft | message | reply | outcome | task | status | approval | note
CREATE TABLE activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id),
  task_id INTEGER REFERENCES tasks(id),
  approval_id INTEGER,
  parent_id INTEGER REFERENCES activities(id),
  type TEXT NOT NULL,
  message_kind TEXT CHECK (message_kind IN ('first_email','follow_up','other')),
  channel TEXT,
  outcome TEXT CHECK (outcome IN ('sent','reply_received','bounced','no_response_yet','opted_out')),
  title TEXT,
  body TEXT,
  ref TEXT,
  url TEXT,
  stage_from TEXT,
  stage_to TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_act_lead ON activities(lead_id, occurred_at);
CREATE INDEX idx_act_type ON activities(type, occurred_at);
CREATE INDEX idx_act_parent ON activities(parent_id);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  lead_id INTEGER REFERENCES leads(id),
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft','findings','other')),
  title TEXT NOT NULL,
  content TEXT,
  requires TEXT NOT NULL CHECK (requires IN ('chief','wisam')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','changes_requested')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  comment TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_appr_status ON approvals(status, requires);

-- Read-only change history (no update/delete code paths exist).
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
`,
];
