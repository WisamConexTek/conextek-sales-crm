import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { campaignReport } from "@/lib/service/schedule";
import { listSenders } from "@/lib/service/senders";
import { unassignedLeads } from "@/lib/service/campaigns";
import { assignableUsers } from "@/lib/service/users";
import { Badge, Card, Empty, Flash, LeadLink, PageHeader } from "@/components/ui";
import { createCampaignAction, setCampaignStatusAction, enrolLeadAction } from "@/app/actions";
import { sget, snum, type SP } from "@/lib/view";
import { pct } from "@/lib/format";

const rate = (r: { numerator: number; denominator: number; value: number | null }) => (r.denominator ? `${pct(r.value)} (${r.numerator}/${r.denominator})` : "—");
const STATUS = { draft: "gray", active: "green", paused: "amber", closed: "blue" } as const;

export default async function Campaigns({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const senderFilter = snum(sp, "sender");
  const [rep, senders] = await Promise.all([campaignReport(me, undefined, senderFilter), listSenders()]);
  const manage = can(me, "campaigns.manage");
  const users = await assignableUsers();
  const un = manage ? await unassignedLeads(me, 1, 50) : null;
  return (
    <div className="space-y-5">
      <PageHeader title="Campaigns" sub="ConexTek · unique leads, preparation backlog, approved scheduled work and actual activity" />
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      <form className="card flex flex-wrap items-end gap-3 p-3">
        <div><label className="label">Sender</label><select name="sender" defaultValue={senderFilter ?? ""} className="input"><option value="">All senders</option>{senders.map((x) => <option key={x.id} value={x.id}>{x.display_name} ({x.email})</option>)}</select></div>
        <button className="btn">Filter</button>
        {senderFilter ? <span className="text-xs text-slate-500">Message, reply and bounce numbers below are for this sender only; lead and task counts are not sender-based.</span> : null}
      </form>
      <div className="grid gap-4 lg:grid-cols-3">
        {rep.campaigns.map((c) => (
          <Card key={c.id} title={c.name} right={<span className="flex items-center gap-2"><Link href={`/leads?campaign=${c.id}`} className="text-xs">Leads →</Link><Link href={`/schedule?open=1&campaign=${c.id}`} className="text-xs">Open work →</Link><Badge tone={STATUS[c.status as keyof typeof STATUS]}>{c.status}</Badge></span>}>
            <p className="mb-2 text-xs text-slate-500">{c.project} · owner {c.owner_name ?? "unassigned"}{c.target_markets ? ` · ${c.target_markets}` : ""}{c.objective ? ` · ${c.objective}` : ""}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Unique leads</dt><dd className="font-medium"><Link href={`/leads?campaign=${c.id}`}>{c.unique_leads}</Link>{c.unique_leads_historical_only ? <span className="text-xs text-slate-400"> ({c.unique_leads_historical_only} historical)</span> : null}</dd>
              <dt className="text-slate-500">Preparation backlog</dt><dd className="font-medium">{c.preparation_backlog}</dd>
              <dt className="text-slate-500">Approved, scheduled</dt><dd className="font-medium">{c.approved_scheduled}</dd>
              <dt className="text-slate-500">Planned / completed tasks</dt><dd>{c.planned_tasks} / {c.completed_tasks}</dd>
              <dt className="text-slate-500">First emails sent</dt><dd className="font-medium">{c.first_emails}</dd>
              <dt className="text-slate-500">Follow-ups sent</dt><dd className="font-medium">{c.follow_ups}</dd>
              <dt className="text-slate-500">Replies (leads)</dt><dd className="font-medium">{c.replies} ({c.reply_leads})</dd>
              <dt className="text-slate-500">Positive replies</dt><dd className="font-medium">{c.positive_reply_leads}</dd>
              <dt className="text-slate-500">Meetings · Won · Lost</dt><dd>{c.meetings} · {c.won} · {c.lost}</dd>
              <dt className="text-slate-500">Reply rate</dt><dd>{rate(c.rates.reply_rate)}</dd>
              <dt className="text-slate-500">First-email bounce rate</dt><dd>{rate(c.rates.first_email_bounce_rate)}</dd>
              {!senderFilter && c.by_sender.length > 1 && <><dt className="text-slate-500">By sender (1st / follow-up / replies)</dt><dd className="text-xs">{c.by_sender.map((x) => <div key={x.sender_id}>{x.name ?? x.sender_id}: {x.first_emails} / {x.follow_ups} / {x.replies}</div>)}</dd></>}
              <dt className="text-slate-500">Positive ÷ replied</dt><dd>{rate(c.rates.positive_reply_rate)}</dd>
            </dl>
            {manage && (
              <form action={setCampaignStatusAction} className="mt-3 flex items-center gap-2">
                <input type="hidden" name="id" value={c.id} /><input type="hidden" name="_back" value="/campaigns" />
                <select name="status" defaultValue={c.status} className="input w-32">{["draft", "active", "paused", "closed"].map((s) => <option key={s}>{s}</option>)}</select>
                <button className="btn btn-sm">Set status</button>
              </form>
            )}
          </Card>
        ))}
      </div>
      <details className="rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600"><summary className="font-medium">How these numbers are defined</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{Object.values(rep.rules).map((t) => <li key={t}>{t}</li>)}</ul></details>
      {manage && (
        <Card title="New campaign">
          <form action={createCampaignAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="_back" value="/campaigns" />
            <div><label className="label">Name *</label><input name="name" required className="input" /></div>
            <div><label className="label">Owner</label><select name="owner_id" className="input"><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <div><label className="label">Target markets</label><input name="target_markets" className="input" placeholder="UAE, KSA" /></div>
            <div className="min-w-64 flex-1"><label className="label">Objective</label><input name="objective" className="input" /></div>
            <div><label className="label">Status</label><select name="status" className="input"><option>draft</option><option>active</option></select></div>
            <button className="btn btn-primary">Create</button>
          </form>
        </Card>
      )}
      {un && (
        <Card title={`Leads with no campaign (${un.total})`} right={<span className="text-xs text-slate-500">migration review queue — nothing is placed automatically</span>}>
          {un.rows.length === 0 ? <Empty>Every real lead belongs to a campaign.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {un.rows.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div><LeadLink id={l.id} company={l.company} /> <span className="text-xs text-slate-500">{[l.country, l.market, l.segment, l.stage].filter(Boolean).join(" · ")}</span></div>
                  <form action={enrolLeadAction} className="flex items-center gap-2">
                    <input type="hidden" name="lead_id" value={l.id} /><input type="hidden" name="_back" value="/campaigns" />
                    <select name="campaign_id" className="input w-44">{rep.campaigns.filter((c) => c.status !== "closed").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    <button className="btn btn-sm">Add</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {un.total > un.rows.length && <p className="mt-2 text-xs text-slate-500">Showing the first {un.rows.length}. Use <code>GET /api/v1/campaigns/unassigned</code> for the rest.</p>}
        </Card>
      )}
      <p className="text-xs text-slate-400">{isManager(me) ? "" : ""}Leads are placed in a campaign only when someone confirms it, never guessed from notes. <Link href="/schedule">Today &amp; Tomorrow →</Link></p>
    </div>
  );
}
