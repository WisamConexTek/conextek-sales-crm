# ConexTek CRM — agent briefing (version 2026-11-09.2)
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
Your work list: GET /schedule?view=today|tomorrow (state: overdue|blocked|ready|planned|completed). Do only 'ready' work, and only after the eligibility check below.

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
