"use client";
import { useState } from "react";

type Opt = { id: number; label: string };
type KV = { key: string; label: string };

export function RecordForm({
  action, leadId, back, contacts, messages, channels, canSend,
}: {
  action: (fd: FormData) => Promise<void>; leadId: number; back: string; contacts: Opt[]; messages: Opt[]; channels: KV[]; canSend: boolean;
}) {
  const [type, setType] = useState(canSend ? "message" : "research");
  const showContact = ["message", "reply", "outcome"].includes(type);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="_back" value={back} />
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label">What are you recording?</label>
          <select name="type" value={type} onChange={(e) => setType(e.target.value)} className="input">
            {canSend && <option value="message">Message SENT (it really went out)</option>}
            <option value="reply">Reply received</option>
            <option value="outcome">Outcome of a sent message (bounce / opt-out / no response)</option>
            <option value="research">Research finding</option>
            <option value="draft">Draft (not sent)</option>
            <option value="note">Note</option>
          </select>
        </div>
        {type === "message" && (
          <div><label className="label">Kind *</label>
            <select name="message_kind" className="input" required defaultValue="">
              <option value="" disabled>Choose…</option><option value="first_email">First email</option><option value="follow_up">Follow-up</option><option value="other">Other message</option>
            </select></div>
        )}
        {(type === "message" || type === "reply") && (
          <div><label className="label">Channel</label>
            <select name="channel" className="input" defaultValue=""><option value="">—</option>{channels.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
        )}
        {type === "outcome" && (
          <>
            <div><label className="label">Which sent message? *</label>
              <select name="parent_id" className="input" required defaultValue=""><option value="" disabled>Choose…</option>{messages.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
            <div><label className="label">Outcome *</label>
              <select name="outcome" className="input" required defaultValue=""><option value="" disabled>Choose…</option><option value="bounced">Bounced</option><option value="no_response_yet">No response yet</option><option value="opted_out">Opted out</option></select></div>
          </>
        )}
        {type === "reply" && messages.length > 0 && (
          <div><label className="label">In reply to (optional)</label>
            <select name="parent_id" className="input" defaultValue=""><option value="">—</option>{messages.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
        )}
        {showContact && type !== "outcome" && (
          <div><label className="label">Contact</label>
            <select name="contact_id" className="input" defaultValue=""><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        )}
        <div><label className="label">When it happened (leave blank for now)</label><input type="datetime-local" name="occurred_at" className="input" /></div>
      </div>
      {type !== "outcome" && (
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label">{type === "message" ? "Subject" : "Title"}</label><input name="title" className="input" /></div>
          <div><label className="label">{type === "message" ? "Message reference / ID" : "Reference"}</label><input name="ref" className="input" placeholder="e.g. mailbox message ID, thread ref" /></div>
        </div>
      )}
      {type !== "outcome" && (
        <div><label className="label">{type === "message" ? "Message body (what was sent)" : type === "reply" ? "Reply text" : type === "draft" ? "Draft text" : "Details"}</label><textarea name="body" className="input min-h-28" /></div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div><label className="label">Link (message, thread, source page…)</label><input name="url" className="input" placeholder="https://" /></div>
      </div>
      <p className="text-xs text-slate-500">
        {type === "message" ? "Only record a send after it has actually happened. This does not send anything." : "Recording here never sends anything — it only saves what you did."}
      </p>
      <button className="btn btn-primary">Save to history</button>
    </form>
  );
}
