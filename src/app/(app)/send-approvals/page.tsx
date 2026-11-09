import { requireUser } from "@/lib/auth";
import { canAuthorizeSend, listDecisions, pendingSendApprovals, recentSendAuthorizations, sendDelegationStatus } from "@/lib/service/sends";
import { assignableUsers } from "@/lib/service/users";
import { Badge, Card, Empty, Flash, LeadLink, PageHeader } from "@/components/ui";
import { SelectAll } from "@/components/SelectAll";
import { approveSendsAction, editDraftAction, rejectDraftAction, setSendDelegationAction } from "@/app/actions";
import { fmtDateTime } from "@/lib/format";
import { sget, type SP } from "@/lib/view";
import { all } from "@/lib/db";
import { listSenders } from "@/lib/service/senders";

export default async function SendApprovals({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  if (!(await canAuthorizeSend(me))) {
    return <div><PageHeader title="Send approvals" /><Card><p className="text-sm text-slate-600">Only the Owner, or the Chief the Owner has delegated to, can approve sending a message.</p></Card></div>;
  }
  const [rows, recent, delegation, decisions] = await Promise.all([pendingSendApprovals(me), recentSendAuthorizations(me, 30), sendDelegationStatus(), listDecisions(me, { limit: 15 })]);
  const senderList = await listSenders();
  const chiefs = me.role === "owner" ? (await all("SELECT id,name FROM users WHERE role='chief' AND active=1 ORDER BY id")) : [];
  void assignableUsers;
  return (
    <div className="space-y-5">
      <PageHeader title="Send approvals" sub={`${rows.length} message version${rows.length === 1 ? "" : "s"} waiting for permission to send`} />
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Approving a send gives permission for <b>exactly this text</b>, to this recipient, on this channel, for this campaign. The CRM sends nothing: the message is sent from the browser workflow, and the send is then recorded. If anyone edits the text, the approval is cancelled and the new version appears here again.
      </div>
      {rows.length === 0 ? <Card><Empty>No message versions are waiting for send approval.</Empty></Card> : (
        <form action={approveSendsAction} className="space-y-3">
          <input type="hidden" name="_back" value="/send-approvals" />
          <div className="card sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 p-3">
            <SelectAll name="v" />
            <button className="btn btn-primary">Approve selected</button>
          </div>
          {rows.map((v) => (
            <Card key={v.id as number}>
              <div className="flex flex-wrap items-start gap-3">
                <input type="checkbox" name="v" value={v.id as number} className="mt-1.5" aria-label={`Select version ${v.id}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold"><LeadLink id={v.lead_id as number} company={v.company as string} /></span>
                    <Badge tone="gray">Version #{v.id as number} (v{v.version as number})</Badge>
                    <Badge tone="purple">{v.campaign as string}</Badge>
                    <Badge tone="blue">{v.channel as string}</Badge>
                    <Badge tone="sky">From: {v.sender_name as string} &lt;{v.sender_email as string}&gt;</Badge>
                    <Badge tone={v.editorial_reviewed ? "green" : "amber"}>{v.editorial_status as string}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">To: <b className="text-slate-700">{(v.recipient_name as string) ?? "shared inbox"}{v.recipient_email ? ` <${v.recipient_email}>` : ""}</b> · prepared by {v.prepared_by as string} · {fmtDateTime(v.created_at as string)}</div>
                  <div className="mt-2 text-sm"><span className="text-xs font-medium uppercase tracking-wide text-slate-500">Subject</span><div className="font-medium" dir="auto">{(v.subject as string) || "(no subject)"}</div></div>
                  <div className="mt-2 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap" dir="auto">{v.body as string}</div>
                  {(v.other_blockers as string[]).length > 0 && <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">Even if approved, this cannot be sent yet: {(v.other_blockers as string[]).join("; ")}.</div>}
                  {(v.warnings as string[]).length > 0 && <div className="mt-1 text-xs text-amber-700">{(v.warnings as string[]).join("; ")}</div>}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="text-xs text-slate-500">Permitted action{" "}
                      <select name={`action_${v.id}`} defaultValue={v.suggested_action as string} className="input inline-block w-36">
                        <option value="first_email">First email</option><option value="follow_up">Follow-up</option><option value="other">Other</option>
                      </select></label>
                    <button name="only" value={v.id as number} className="btn btn-ok btn-sm">Approve send</button>
                    <a href={`#edit-${v.id}`} className="btn btn-sm">Edit / reject…</a>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </form>
      )}
      {rows.length > 0 && (
        <Card title="Edit or reject a draft">
          <p className="mb-3 text-sm text-slate-600"><b>Edit</b> saves your text as a new version (the old one is kept) that you then approve above. <b>Reject</b> needs a reason; it is saved so the agents know what happened and prepare a new version.</p>
          <div className="space-y-3">
            {rows.map((v) => (
              <details key={v.id as number} id={`edit-${v.id}`} className="rounded-md border border-slate-200 p-3 open:bg-slate-50 target:ring-2 target:ring-blue-300">
                <summary className="cursor-pointer text-sm font-medium">{v.company as string} · version #{v.id as number} · {v.channel as string}</summary>
                <form action={editDraftAction} className="mt-3 space-y-2">
                  <input type="hidden" name="_back" value="/send-approvals" /><input type="hidden" name="id" value={v.id as number} />
                  <div><label className="label">Send from</label><select name="sender_id" defaultValue={v.sender_id as number} className="input">{senderList.map((x) => <option key={x.id} value={x.id}>{x.display_name} &lt;{x.email}&gt;{x.active ? "" : " (off)"}{x.paused_at ? " (paused)" : ""}</option>)}</select></div>
                  <div><label className="label">Subject</label><input name="subject" defaultValue={(v.subject as string) ?? ""} className="input" dir="auto" /></div>
                  <div><label className="label">Message</label><textarea name="body" required rows={10} defaultValue={v.body as string} className="input font-mono text-sm" dir="auto" /></div>
                  <div><label className="label">What you changed and why (optional, helps the agents)</label><input name="note" className="input" /></div>
                  <button className="btn btn-primary btn-sm">Save as new version</button>
                </form>
                <form action={rejectDraftAction} className="mt-4 space-y-2 border-t border-slate-200 pt-3">
                  <input type="hidden" name="_back" value="/send-approvals" /><input type="hidden" name="id" value={v.id as number} />
                  <div><label className="label">Reject this draft: reason (required)</label><textarea name="reason" required minLength={3} rows={3} className="input" dir="auto" placeholder="e.g. Wrong tone for a dealer group; do not mention pricing in a first email." /></div>
                  <button className="btn btn-sm text-red-700">Reject draft</button>
                </form>
              </details>
            ))}
          </div>
        </Card>
      )}
      {me.role === "owner" && (
        <Card title="Delegate send approval to a Chief">
          <p className="mb-2 text-sm text-slate-600">{delegation.enabled ? <>Currently <b>ON</b>: <b>{delegation.delegate_name}</b> can approve sends. Every approval they make is logged and marked “delegated”.</> : <>Currently <b>OFF</b>: only you can approve sends.</>}</p>
          <form action={setSendDelegationAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="_back" value="/send-approvals" />
            <div><label className="label">Chief</label><select name="user_id" defaultValue={delegation.delegate_user_id ?? chiefs[0]?.id} className="input">{chiefs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <button className="btn btn-primary btn-sm">Turn ON</button>
            <button name="user_id" value="" formNoValidate className="btn btn-sm">Turn OFF</button>
          </form>
        </Card>
      )}
      <Card title="Recent edits and rejections">
        {decisions.length === 0 ? <Empty>None yet.</Empty> : (
          <ul className="space-y-2 text-sm">{decisions.map((d) => (
            <li key={d.id as number} className="border-t border-slate-100 pt-2 first:border-0 first:pt-0">
              <Badge tone={d.kind === "rejected" ? "red" : "blue"}>{d.kind === "rejected" ? "Rejected" : "Edited"}</Badge> {d.company as string} · #{d.message_version_id as number}{d.new_version_id ? ` → #${d.new_version_id}` : ""} · {d.decided_by as string}{d.delegated ? " (delegated)" : ""} · {fmtDateTime(d.created_at as string)}
              {d.reason ? <div className="text-slate-600" dir="auto">{d.reason as string}</div> : null}
            </li>))}</ul>
        )}
      </Card>
      <Card title="Recent send approvals (audit)">
        {recent.length === 0 ? <Empty>No send approvals yet.</Empty> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="font-normal">When</th><th className="font-normal">Lead</th><th className="font-normal">Version</th><th className="font-normal">Action</th><th className="font-normal">Approved by</th><th className="font-normal">Status</th></tr></thead>
            <tbody>{recent.map((a) => (
              <tr key={a.id as number} className="border-t border-slate-100"><td className="py-1">{fmtDateTime(a.created_at as string)}</td><td>{a.company as string}</td><td>#{a.message_version_id as number}</td><td>{(a.permitted_action as string).replace("_", " ")}</td>
                <td>{a.approver as string}{a.delegated ? <> <Badge tone="amber">delegated</Badge></> : null}</td><td>{a.status as string}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
    </div>
  );
}
