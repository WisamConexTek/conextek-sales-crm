# ConexTek CRM — agent briefing (version 2026-11-10.1)
Base URL: the CRM's own address + /api/v1. Auth: header "Authorization: Bearer <your key>". Every response is {ok, data} or {ok:false, error}.
Re-read this guide (GET /api/v1/guide) at the start of each run; if "version" changed, behaviour changed. Full reference for humans: /api-docs.

## Ground rules (never break)
1. The CRM never sends, schedules, scrapes or triggers AI. You send through the browser workflow; the CRM records it.
2. A draft is not a send. Editorial approval (Chief) is not permission to send. Only the Owner's SEND authorization is.
3. Never contact an opted-out, bounced or historical-only lead. Never resend to fix a missing CRM record.
4. Never invent facts: unknown dates, employees, campaigns stay unknown (null). Never use today's date for old events.
5. Test data: pass is_test:true; it is excluded from reports.

## Timestamps
Always send ISO 8601 with Z or an offset: 2026-11-08T10:00:00+02:00 (or ...Z, or +08:00 for Shanghai logs).
Zone-less times are read as Asia/Hebron; times inside a clock-change hour are refused (resend with an offset).
Date-only (2026-11-08) = a day, no hour. "unknown" stays unknown. Words like "next Tuesday" are rejected.
Dates must be real fields (scheduled_at, due_at), never written in a task title.

## Before you create anything: duplicate check (works even for leads you cannot see)
POST /duplicates/check {company, website, emails[], phones[], profiles[]} -> decision:
  duplicate = stop, do not create. review = ambiguous (shared domain/name/phone/profile): POST /duplicates/reviews {existing_lead_id, proposed} and wait for Chief.
  clear = safe to create. do_not_contact:true on a match means never contact.

## Leads, campaigns, tasks
Campaigns: GET /campaigns (ConexTek project: US Car Dealers, Gulf Car Dealers, Canton Fair). Channels: email, linkedin, x.
Create a lead inside a campaign: POST /leads {..., campaign_id}. Move: POST /leads/{id}/campaigns {campaign_id, transfer_from_campaign_id} (409 without the transfer; opted-out leads are refused).
Tasks: POST /tasks {title, lead_id, assignee_id, campaign_id, channel, action_type, scheduled_at, due_at, prep_status, blockers}
  prep_status: validation_needed | draft_needed | internal_review | user_approval_needed | ready_for_execution (preparation only; NOT approval, NOT a sales stage).
  PATCH /tasks/{id}: assignees may change prep_status and blockers; managers change schedule, channel, campaign, action.
  Close a task by hand: POST /tasks/{id}/complete {"activity_id": 661, "note": "why"}. The assignee may do it; so may the Owner or a Chief for someone else's task (audit-logged "by_manager"). activity_id must belong to the same lead; if it is a recorded send, the task also gets sent_at. Use this only outside the automatic flow below. Tasks that need approval must be approved first (managers may bypass).
  Tasks and message versions: every task has message_version_id (null until a draft exists), shown on GET /tasks, /schedule and the lead page. POST /messages/versions links the version to its task (send task_id, or it adopts the one open outreach task of that lead/channel/campaign) and the task always points at the LATEST version of the message.
  Automatic status (you do not set these, and must not work around them):
   - Chief editorial + Owner send authorization on the exact latest version and a passing eligibility check => task prep_status=ready_for_execution, blockers cleared, shown as "Approved, ready to send".
   - Revoked approval, an edit (new version), a rejection, a paused campaign etc. => back to blocked with the correct blocker text (internal_review / user_approval_needed / draft_needed / validation_needed). /schedule computes this live, so counters are always real.
   - When that draft is approved (or its send is recorded), an open draft-preparation task (action_type containing "draft", e.g. prepare_first_email_draft) of the same lead closes by itself.
   - POST /sends recorded => the linked send task becomes completed, with activity_id, sent_at and completed_by = the person who reported the send, whoever the assignee is (audit "task_auto_complete"). POST /sends/{event_id}/reconcile does the same once the record is saved.
  One status everywhere: GET /tasks, GET /tasks/{id}, the lead page and GET /schedule all return the same live fields: state (overdue|blocked|ready|planned|completed), prep_status, blockers (live for tasks linked to a message version), prep_label, reason (plain words: why blocked / held / overdue). Never trust an older cached copy.
  Date-only tasks: send due_at or scheduled_at as "YYYY-MM-DD". They are stored and returned as a pure date: due_on / scheduled_on (due_at / scheduled_at are null, date_only:true, on:"YYYY-MM-DD"). There is no time of day; the real time appears as sent_at once sent.
  Held by the daily send cap: Owner/Chief POST /tasks/{id}/reschedule {"scheduled_at":"<next send slot>","reason":"daily send limit reached, moved to next day"}. The task keeps its old time (rescheduled_from), shows "Held: <reason>", is no longer Overdue, and it is audit-logged. Employees and agents without manager rights cannot do this; do not edit the schedule yourself to dodge the cap.
  Finished tasks: once a task is completed or cancelled, GET /tasks, /tasks/{id}, /schedule and the lead page return prep_status "sent" (with sent_at), "completed" or "cancelled", blockers null and prep_label "Sent"/"Completed"/"Cancelled". Old approval text is never shown on a finished task. Moved tasks carry rescheduled_from (ISO, or rescheduled_from_on for a date-only task) and hold_reason in /schedule as well as /tasks. Timestamps in the API stay ISO; only the web screens show 12-hour AM/PM (Asia/Hebron).
  Housekeeping (Owner/Chief): POST /tasks/reconcile brings tasks in line with approvals and sends that already exist (closes draft-prep tasks whose draft was approved or sent; lists send tasks still open although the send was recorded). Idempotent.
Your work list: GET /schedule?view=today|tomorrow (state: overdue|blocked|ready|planned|completed). Do only 'ready' work, and only after the eligibility check below.

## Contacts, replies, bounces, capacity (added 2026-11-10)
Contacts on an existing lead: POST /leads/{id}/contacts {name?, role, email, phone, linkedin, source_url, language, notes}. name is optional (stored as "(no name)"); give at least one of name/email/phone/linkedin. Before creating, the email is checked across ALL leads (case-insensitive) and against suppressed addresses: a match is 409 with duplicates:[{contact_id, lead_id, company, status, suppressed}] and NOTHING is created (a lead you cannot see returns lead_id null). Allowed: Owner, Chief, and employees with access to that lead. An activity on the lead records who added it. Response: {id, lead_id, status, warnings[]}.
  GET /contacts/{id}. PATCH /contacts/{id} {name, role, email, phone, source_url, language, notes, status}. status: active | invalid | bounced | opted_out. Contacts are NEVER deleted: use a status. Changing an email to one that exists elsewhere is 409. Only Owner/Chief may reactivate a bounced or opted-out contact (audited). Invalid, bounced and opted-out contacts block sends.
Replies: POST /replies {lead_id, contact_id?, received_at (ISO with offset), from, subject, message_id, summary, classification, update_stage?}. classification: interested | soft | not_interested | out_of_office | auto_reply | other. De-duplicated by message_id (repeat = {duplicate:true}). interested/soft/other move the stage UP only (to interested / replied), never backwards and never over meeting/trial/won/lost/closed. not_interested moves the lead to Lost (unless already final), CANCELS its open follow-up tasks and withdraws its active send approvals. out_of_office and auto_reply are logged as notes and are NOT counted as replies. Send update_stage:false to record without any stage change. The response lists the effects.
Bounces: POST /bounces {contact_id, message_id?, bounced_at (ISO with offset), reason}. Marks the contact bounced (never downgrades an opt-out), links the message that bounced, and blocks future eligibility (code "bounced"). De-duplicated by message_id (or contact + time).
Original researcher: POST /leads accepts original_researcher: an employee id, or "unknown". It is the discovery credit shown in reports; the person who entered the lead stays the registrar (imported_by). Giving credit to someone other than yourself needs permission to assign work.
Message versions (read-only): GET /message-versions?campaign_id=&lead_id=&status=&latest_only=1&limit=&page= returns each version with status (waiting_editorial | waiting_send | approved | sent | rejected | superseded), editorial_status, send_status, eligibility {eligible, reasons[], codes[]}, task_id and recipient. GET /message-versions/{id}/authorizations shows who authorized, when, for exactly which version (and any decisions). Chief can read; Chief still cannot create Owner SEND authorizations unless the Owner's delegation switch is on.
Daily send capacity (Asia/Hebron day): GET /capacity?date=YYYY-MM-DD -> {daily_cap, used, reserved, remaining, cap_reached, campaigns:[{campaign_id, name, priority, used, reserved, available_in_priority_order}]}. used = messages recorded as sent that day; reserved = approved tasks scheduled that day not yet sent. The cap is 10 per day unless the Owner changes it: GET/PUT /settings/capacity {daily_cap (0 = no cap), priority:[campaign ids, highest first]} (PUT Owner only). When used reaches the cap, the eligibility check returns code "daily_cap_reached" (reason "daily send cap reached ...") and tasks show it as their blocker; hold the task with POST /tasks/{id}/reschedule.
Eligibility now also returns codes[] (superseded, rejected, no_send_authorization, historical_only, opted_out, bounced, contact_invalid, no_email, campaign_not_active, not_in_campaign, several_campaigns, first_email_already_sent, conflicting_authorization, crm_pending, daily_cap_reached).
Lists: GET /tasks?page=1&page_size=50&q=text pages (50 per page by default) and searches title/company; without page params it returns the plain list as before.

## Sending workflow (the only allowed order)
1. POST /messages/versions {lead_id, contact_id, channel, campaign_id, task_id, subject, body} -> version id. Any edit = a new version; older authorizations are voided.
2. Chief: POST /authorizations {message_version_id, kind:"editorial", permitted_action}. SEND authorization is made only by the Owner (Send approvals screen, or POST /authorizations / POST /authorizations/bulk) or by the one Chief the Owner has delegated to (GET /settings/send-delegation shows the status). You, the agent, can never authorize your own sends. If eligibility says there is no send authorization, tell the Owner which version ids are waiting (GET /authorizations/pending if you are permitted) and stop.
2b. The Owner may EDIT a draft (saved as a NEW version; the old one is kept, and you will see an "edited" decision on it) or REJECT it with a reason. A rejected version can never be sent. Learn from these: GET /messages/decisions (optional ?lead_id=&limit=) returns each decision with reason, old text and new text; GET /messages/versions/{id} shows "decisions" for that version. After a rejection, read the reason, prepare a new, different version (POST /messages/versions) and it returns to the Owner's queue. Re-posting identical text is not a new version. Never re-send or work around a rejection.
3. GET /sends/eligibility?message_version_id=ID -> must be eligible:true. If not, read reasons[] and stop (do not work around).
4. Send in the browser. Then POST /sends {event_id (unique, stable), message_version_id, sent_at (exact, with offset), evidence (message-id/link)}.
5. Read the response: status RECORDED = done. status SENT_CONFIRMED_CRM_PENDING (stop_further_sends:true) = STOP the run, do not resend, call POST /sends/{event_id}/reconcile (safe to repeat) until RECORDED.
Re-sending the same event_id is safe (idempotent). A new event_id for the same authorization is refused.

## Reports / verification
GET /reports?all=1 | from&to | period&at ; GET /campaigns/report (managers). Rates come as {numerator, denominator, value}. Counts use event dates, not entry dates.

## Historical import (only with history.import, normally revoked)
POST /import/history (dry run unless commit:true, max 100 records per request, 413 = halve the batch), /import/lead-dates, /import/reconcile-activities, /import/activity-times.
Normal operations never need these.

## Errors
400 invalid input (message names the field). 403 permission. 404 not found or not yours. 409 blocked by a safety rule (read the message; do not retry blindly). 413 batch too large. 5xx retry later with the same ids.
