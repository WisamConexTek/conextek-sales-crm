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
  `
-- Migration 2: customer segment, task note history, completion actor, Chief key management.
ALTER TABLE leads ADD COLUMN segment TEXT;
ALTER TABLE tasks ADD COLUMN completed_by INTEGER REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN completion_note TEXT;

CREATE TABLE task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('progress','completion')),
  body TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_notes_task ON task_notes(task_id, id);

-- Existing completed tasks: recover who completed them and the completion note from the lead history.
UPDATE tasks SET
  completed_by = COALESCE((SELECT a.actor_id FROM activities a WHERE a.task_id=tasks.id AND a.title LIKE 'Task completed:%' ORDER BY a.id DESC LIMIT 1), assignee_id),
  completion_note = (SELECT a.body FROM activities a WHERE a.task_id=tasks.id AND a.title LIKE 'Task completed:%' ORDER BY a.id DESC LIMIT 1)
WHERE status='completed';

-- Keep every existing note: progress notes first, then completion notes.
INSERT INTO task_notes (task_id,kind,body,actor_id,created_at)
  SELECT id,'progress',progress_note,assignee_id,updated_at FROM tasks
  WHERE progress_note IS NOT NULL AND TRIM(progress_note)<>'' AND progress_note IS NOT COALESCE(completion_note,'');
INSERT INTO task_notes (task_id,kind,body,actor_id,created_at)
  SELECT id,'completion',completion_note,completed_by,COALESCE(completed_at,updated_at) FROM tasks
  WHERE completion_note IS NOT NULL AND TRIM(completion_note)<>'';

-- Chiefs may issue/revoke employee API keys (the Owner can switch this off per person).
UPDATE users SET permissions = json_insert(permissions,'$[#]','keys.manage')
  WHERE role='chief' AND permissions NOT LIKE '%keys.manage%';
`,
  `
-- Migration 3: original lead dates, event-date precision, historical import tracking.
-- lead_date: when the lead really came into existence (NOT when it was entered). NULL = unknown (never assumed).
-- lead_date_precision: 'day' (date only) or 'time'. created_at keeps meaning "when it was registered here".
ALTER TABLE leads ADD COLUMN lead_date TEXT;
ALTER TABLE leads ADD COLUMN lead_date_precision TEXT;
ALTER TABLE leads ADD COLUMN external_id TEXT;
ALTER TABLE leads ADD COLUMN imported_by INTEGER REFERENCES users(id);
ALTER TABLE leads ADD COLUMN import_batch_id INTEGER;

-- occurred_precision: 'time' | 'day' | 'unknown'. For 'unknown' occurred_at only holds the registration time and is ignored by period reports.
ALTER TABLE activities ADD COLUMN occurred_precision TEXT NOT NULL DEFAULT 'time';
ALTER TABLE activities ADD COLUMN external_id TEXT;
ALTER TABLE activities ADD COLUMN imported_by INTEGER REFERENCES users(id);
ALTER TABLE activities ADD COLUMN import_batch_id INTEGER;

CREATE UNIQUE INDEX idx_leads_external ON leads(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_act_external ON activities(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_leads_lead_date ON leads(lead_date);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  imported_by INTEGER NOT NULL REFERENCES users(id),
  summary TEXT,
  created_at TEXT NOT NULL
);
`,
  `
-- Migration 4: unknown original actor, historical-only (suppressed) entities, time-limited migration access.
-- activities.actor_id becomes nullable: NULL = the original employee is unknown (never replaced by the importer).
CREATE TABLE activities_new (
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
  actor_id INTEGER REFERENCES users(id),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  occurred_precision TEXT NOT NULL DEFAULT 'time',
  external_id TEXT,
  imported_by INTEGER REFERENCES users(id),
  import_batch_id INTEGER
);
INSERT INTO activities_new (id,lead_id,contact_id,task_id,approval_id,parent_id,type,message_kind,channel,outcome,title,body,ref,url,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,imported_by,import_batch_id)
  SELECT id,lead_id,contact_id,task_id,approval_id,parent_id,type,message_kind,channel,outcome,title,body,ref,url,stage_from,stage_to,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,imported_by,import_batch_id FROM activities;
DROP TABLE activities;
ALTER TABLE activities_new RENAME TO activities;
CREATE INDEX idx_act_lead ON activities(lead_id, occurred_at);
CREATE INDEX idx_act_type ON activities(type, occurred_at);
CREATE INDEX idx_act_parent ON activities(parent_id);
CREATE UNIQUE INDEX idx_act_external ON activities(external_id) WHERE external_id IS NOT NULL;

-- historical_only: a company/contact kept only so its past replies, bounces and opt-outs are on record.
-- Never an outreach prospect: hidden from default lead lists and stage counts, no tasks, not a "lead added".
ALTER TABLE leads ADD COLUMN historical_only INTEGER NOT NULL DEFAULT 0;
-- Owner-granted, time-limited migration access (history.import stops working after this moment).
ALTER TABLE users ADD COLUMN history_import_until TEXT;
`,
  `
-- Migration 5 (additive only): projects, campaigns, channels, campaign membership, task scheduling and
-- preparation status, read-only legacy archive. Nothing existing is changed, moved, reset or deleted.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  created_at TEXT NOT NULL
);
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  target_markets TEXT,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One canonical lead; membership is history. A lead can have several rows over time, but only one 'active' at once
-- unless a manager enrols it in a second campaign explicitly. is_original marks original-source attribution.
CREATE TABLE lead_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','transferred','removed')),
  is_original INTEGER NOT NULL DEFAULT 0,
  transferred_from INTEGER REFERENCES campaigns(id),
  added_by INTEGER REFERENCES users(id),
  note TEXT,
  joined_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (lead_id, campaign_id)
);
CREATE INDEX idx_lc_campaign ON lead_campaigns(campaign_id, status);
-- Structured task fields. All nullable: NULL = unknown, never guessed for existing tasks.
ALTER TABLE tasks ADD COLUMN scheduled_at TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_input TEXT;
ALTER TABLE tasks ADD COLUMN channel TEXT;
ALTER TABLE tasks ADD COLUMN action_type TEXT;
ALTER TABLE tasks ADD COLUMN prep_status TEXT CHECK (prep_status IS NULL OR prep_status IN ('validation_needed','draft_needed','internal_review','user_approval_needed','ready_for_execution'));
ALTER TABLE tasks ADD COLUMN blockers TEXT;
ALTER TABLE tasks ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
CREATE INDEX idx_tasks_sched ON tasks(scheduled_at);
-- Read-only copy of free-text sources, with provenance. Rows cannot be changed or removed.
CREATE TABLE legacy_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  content TEXT NOT NULL,
  source_updated_at TEXT,
  archived_at TEXT NOT NULL,
  UNIQUE (entity, entity_id, field)
);
CREATE TRIGGER legacy_archive_no_update BEFORE UPDATE ON legacy_archive BEGIN SELECT RAISE(ABORT,'legacy_archive is read-only'); END;
CREATE TRIGGER legacy_archive_no_delete BEFORE DELETE ON legacy_archive BEGIN SELECT RAISE(ABORT,'legacy_archive is read-only'); END;
INSERT INTO legacy_archive (entity,entity_id,field,content,source_updated_at,archived_at)
  SELECT 'lead',id,'notes',notes,updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM leads WHERE notes IS NOT NULL AND TRIM(notes)<>'';
INSERT INTO legacy_archive (entity,entity_id,field,content,source_updated_at,archived_at)
  SELECT 'lead',id,'next_action',next_action,updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM leads WHERE next_action IS NOT NULL AND TRIM(next_action)<>'';
INSERT INTO legacy_archive (entity,entity_id,field,content,source_updated_at,archived_at)
  SELECT 'task',id,'title',title,updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks;
INSERT INTO legacy_archive (entity,entity_id,field,content,source_updated_at,archived_at)
  SELECT 'task',id,'instructions',instructions,updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks WHERE instructions IS NOT NULL AND TRIM(instructions)<>'';
INSERT INTO legacy_archive (entity,entity_id,field,content,source_updated_at,archived_at)
  SELECT 'approval',id,'content',content,decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM approvals WHERE content IS NOT NULL AND TRIM(content)<>'';
-- Seed reference data (projects/campaigns/channels). No lead is placed in any campaign here: that needs evidence.
INSERT INTO projects (key,name,created_at) VALUES ('conextek','ConexTek',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO channels (key,name) VALUES ('email','Email'),('linkedin','LinkedIn'),('x','X');
INSERT INTO campaigns (project_id,key,name,status,created_at,updated_at)
  SELECT p.id,c.k,c.n,'draft',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM projects p,
  (SELECT 'us_car_dealers' AS k,'US Car Dealers' AS n UNION ALL SELECT 'gulf_car_dealers','Gulf Car Dealers' UNION ALL SELECT 'canton_fair','Canton Fair') c WHERE p.key='conextek';
UPDATE users SET permissions = json_insert(permissions,'$[#]','campaigns.manage')
  WHERE role='chief' AND permissions NOT LIKE '%campaigns.manage%';
`,
  `
-- Migration 6 (additive): immutable message versions, scoped authorizations, send events, duplicate reviews.
CREATE TABLE message_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  contact_id INTEGER REFERENCES contacts(id),
  channel TEXT NOT NULL REFERENCES channels(key),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  task_id INTEGER REFERENCES tasks(id),
  version INTEGER NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mv_thread ON message_versions(lead_id, contact_id, channel, campaign_id, version);
CREATE TRIGGER message_versions_no_update BEFORE UPDATE ON message_versions BEGIN SELECT RAISE(ABORT,'message versions are immutable: create a new version'); END;
CREATE TRIGGER message_versions_no_delete BEFORE DELETE ON message_versions BEGIN SELECT RAISE(ABORT,'message versions are immutable'); END;
-- An authorization names the exact version, recipient, channel, campaign and permitted action.
-- editorial = Chief/editor review. send = the Owner's permission to send. They are different records.
CREATE TABLE send_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_version_id INTEGER NOT NULL REFERENCES message_versions(id),
  lead_id INTEGER NOT NULL,
  contact_id INTEGER,
  channel TEXT NOT NULL,
  campaign_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('editorial','send')),
  permitted_action TEXT NOT NULL CHECK (permitted_action IN ('first_email','follow_up','other')),
  approver_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','used')),
  note TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,
  send_event_id INTEGER
);
CREATE INDEX idx_sa_version ON send_authorizations(message_version_id, kind, status);
-- Durable evidence of a confirmed send. event_id makes the report idempotent. The CRM never sends anything.
CREATE TABLE send_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  message_version_id INTEGER NOT NULL REFERENCES message_versions(id),
  authorization_id INTEGER NOT NULL REFERENCES send_authorizations(id),
  lead_id INTEGER NOT NULL,
  contact_id INTEGER,
  channel TEXT NOT NULL,
  campaign_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT_CONFIRMED_CRM_PENDING','RECORDED')),
  sent_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reported_by INTEGER NOT NULL REFERENCES users(id),
  activity_id INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Ambiguous identity matches wait here for a Chief decision. Nothing is merged automatically.
CREATE TABLE duplicate_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  existing_lead_id INTEGER NOT NULL REFERENCES leads(id),
  proposed TEXT NOT NULL,
  signals TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','same','different')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
`,
  `
-- Migration 7 (additive): Owner-controlled delegation of send authorization.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
-- 1 when the authorization was made by a delegate (not the Owner). Existing rows stay 0.
ALTER TABLE send_authorizations ADD COLUMN delegated INTEGER NOT NULL DEFAULT 0;
`,
  `
-- Migration 8 (additive): Owner decisions on drafts, so agents learn what happened and why.
-- Message versions stay immutable: an edit creates a new version; a rejection is recorded here.
CREATE TABLE message_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_version_id INTEGER NOT NULL REFERENCES message_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('rejected','edited')),
  reason TEXT,
  new_version_id INTEGER REFERENCES message_versions(id),
  decided_by INTEGER NOT NULL REFERENCES users(id),
  delegated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_md_version ON message_decisions(message_version_id, kind);
`,
  `
-- Migration 9 (additive): Link task completion to an activity that proves the work happened.
ALTER TABLE tasks ADD COLUMN activity_id INTEGER REFERENCES activities(id);
`,
  `
-- Migration 9 (additive): a task knows which message version it will send, and when it was really sent.
ALTER TABLE tasks ADD COLUMN message_version_id INTEGER REFERENCES message_versions(id);
ALTER TABLE tasks ADD COLUMN sent_at TEXT;
-- Backfill the link only where a version already names the task: point at the latest version of that thread.
UPDATE tasks SET message_version_id = (
  SELECT v2.id FROM message_versions v1 JOIN message_versions v2 ON v2.lead_id=v1.lead_id AND COALESCE(v2.contact_id,0)=COALESCE(v1.contact_id,0) AND v2.channel=v1.channel AND v2.campaign_id=v1.campaign_id
  WHERE v1.task_id=tasks.id ORDER BY v2.version DESC, v2.id DESC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM message_versions v WHERE v.task_id=tasks.id);
CREATE INDEX idx_tasks_version ON tasks(message_version_id);
`,
  `
-- Migration 10 (additive): date-only deadlines are kept as pure dates; a held task records why it was moved.
ALTER TABLE tasks ADD COLUMN due_on TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_on TEXT;
ALTER TABLE tasks ADD COLUMN hold_reason TEXT;
ALTER TABLE tasks ADD COLUMN rescheduled_from TEXT;
-- Backfill the pure date for existing date-only tasks (stored earlier as 23:59 local = 21:59Z in winter, 20:59Z in summer for Asia/Hebron). due_at itself is untouched.
UPDATE tasks SET due_on = date(due_at,'+2 hours') WHERE due_at IS NOT NULL AND substr(due_at,12,5)='21:59';
UPDATE tasks SET due_on = date(due_at,'+3 hours') WHERE due_at IS NOT NULL AND substr(due_at,12,5)='20:59' AND due_on IS NULL;
UPDATE tasks SET scheduled_on = scheduled_input WHERE scheduled_input GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
`,
  `
-- Migration 11 (additive): contact source/language/invalid flag, reply classification, and indexes for the filters and joins the app uses.
ALTER TABLE contacts ADD COLUMN source_url TEXT;
ALTER TABLE contacts ADD COLUMN language TEXT;
ALTER TABLE contacts ADD COLUMN is_invalid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN classification TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_email_lower ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(email_status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_sched ON tasks(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due_on ON tasks(due_on);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_act_task ON activities(task_id);
CREATE INDEX IF NOT EXISTS idx_act_contact ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_act_lead_type ON activities(lead_id, type);
CREATE INDEX IF NOT EXISTS idx_sa_lead ON send_authorizations(lead_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_se_lead ON send_events(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_se_activity ON send_events(activity_id);
CREATE INDEX IF NOT EXISTS idx_lc_lead ON lead_campaigns(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_mv_task ON message_versions(task_id);
CREATE INDEX IF NOT EXISTS idx_mv_campaign ON message_versions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_by ON leads(created_by);
CREATE INDEX IF NOT EXISTS idx_leads_last_activity ON leads(last_activity_at);
`,
  `
-- Migration 12 (additive): sending mailboxes ("senders"), per-sender warm-up/caps, deliverability guard, spam complaints.
CREATE TABLE IF NOT EXISTS senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  title TEXT,
  domain TEXT NOT NULL,
  languages TEXT NOT NULL DEFAULT '["en"]',
  campaign_ids TEXT,
  daily_cap INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  paused_at TEXT,
  paused_by INTEGER REFERENCES users(id),
  pause_reason TEXT,
  pause_kind TEXT CHECK (pause_kind IN ('auto','manual')),
  resumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Warm-up schedule: from from_date (inclusive, Asia/Hebron day) the sender may send daily_cap per day. Before the first step the cap is 0.
CREATE TABLE IF NOT EXISTS sender_warmup (
  sender_id INTEGER NOT NULL REFERENCES senders(id),
  from_date TEXT NOT NULL,
  daily_cap INTEGER NOT NULL,
  PRIMARY KEY (sender_id, from_date)
);
CREATE TABLE IF NOT EXISTS sender_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES senders(id),
  action TEXT NOT NULL,
  reason TEXT,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sender_events ON sender_events(sender_id, id);
CREATE TABLE IF NOT EXISTS spam_complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES senders(id),
  lead_id INTEGER REFERENCES leads(id),
  contact_id INTEGER REFERENCES contacts(id),
  message_id TEXT,
  external_id TEXT UNIQUE,
  occurred_at TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_complaints_sender ON spam_complaints(sender_id, occurred_at);
-- Existing mailbox: all history belongs to it. Its cap is the former shared daily cap (default 10).
INSERT OR IGNORE INTO senders (id,email,display_name,title,domain,languages,campaign_ids,daily_cap,active,created_at,updated_at)
VALUES (1,'wisam.alaysa@conextek.com','Wisam Alaysa','Owner','conextek.com','["en","ar"]',NULL,
  (SELECT CASE WHEN CAST(value AS INTEGER)=0 THEN NULL ELSE CAST(value AS INTEGER) END FROM app_settings WHERE key='daily_send_cap' AND value IS NOT NULL AND value<>''),
  1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE senders SET daily_cap=10 WHERE id=1 AND daily_cap IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key='daily_send_cap');
INSERT OR IGNORE INTO senders (id,email,display_name,title,domain,languages,campaign_ids,daily_cap,active,created_at,updated_at)
VALUES (2,'madison@conextek.us','Madison Brooks','Business Development Representative','conextek.us','["en"]',
  (SELECT NULLIF(json_group_array(id),'[]') FROM campaigns WHERE lower(name) LIKE 'us %' OR lower(name) LIKE '%china%' OR lower(name) LIKE '%canton%' OR lower(name) LIKE '%united states%'),
  NULL,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO sender_warmup (sender_id,from_date,daily_cap) VALUES (2,'2026-11-10',5),(2,'2026-11-17',8),(2,'2026-11-24',12),(2,'2026-12-01',20),(2,'2026-12-08',25);
-- Every version and send names its sender. Existing rows default to sender 1 (no content is rewritten).
ALTER TABLE message_versions ADD COLUMN sender_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE message_versions ADD COLUMN language TEXT;
ALTER TABLE send_events ADD COLUMN sender_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activities ADD COLUMN sender_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_mv_sender ON message_versions(sender_id);
CREATE INDEX IF NOT EXISTS idx_se_sender ON send_events(sender_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_act_sender ON activities(sender_id, occurred_at);
-- Campaign priority for reserving capacity: China, then US, then Gulf (only if the Owner has not set one).
INSERT OR IGNORE INTO app_settings (key,value,updated_at)
SELECT 'campaign_priority', json_group_array(id), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (SELECT id FROM campaigns ORDER BY CASE WHEN lower(name) LIKE '%canton%' OR lower(name) LIKE '%china%' THEN 0 WHEN lower(name) LIKE 'us %' THEN 1 WHEN lower(name) LIKE '%gulf%' THEN 2 ELSE 3 END, id) WHERE EXISTS (SELECT 1 FROM campaigns);
`,
];
