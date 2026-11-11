import Link from "next/link";
import { requireUser, can } from "@/lib/auth";
import { listLeads, leadListExtras, ATTENTION, type Attention } from "@/lib/service/leads";
import { listCampaigns } from "@/lib/service/campaigns";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import { PageHeader, Flash, StageBadge, DemoBadge, Empty, Badge } from "@/components/ui";
import { fmtDate, fmtShort, fmtYmd, isOverdue } from "@/lib/format";
import { demoOn, q, sget, snum, type SP } from "@/lib/view";

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const f = { q: sget(sp, "q"), owner: snum(sp, "owner"), market: sget(sp, "market"), segment: sget(sp, "segment"), stage: sget(sp, "stage"), channel: sget(sp, "channel"), sort: sget(sp, "sort"), page: snum(sp, "page") ?? 1,
    campaign: snum(sp, "campaign"), attention: (ATTENTION as readonly string[]).includes(sget(sp, "attention") ?? "") ? (sget(sp, "attention") as Attention) : undefined };
  const [res, lists, users, camps] = await Promise.all([listLeads(me, { ...f, includeDemo: await demoOn(), includeHistorical: sget(sp, "hide_hist") !== "1" }), getLists(true), assignableUsers(), listCampaigns()]);
  const ATTENTION_LABEL: Record<Attention, string> = { unanswered: "Reply not answered yet", quiet: "Nothing planned, quiet 7+ days" };
  const extra = await leadListExtras(res.rows.map((l) => l.id as number));
  const STATE_TONE = { overdue: "red", blocked: "amber", ready: "green", planned: "gray", completed: "blue" } as const;
  const label = (kind: string) => Object.fromEntries(lists[kind].map((i) => [i.key, i.label]));
  const stages = label("stage"), markets = label("market");
  const flag = Object.fromEntries(lists.stage.map((i) => [i.key, i.flag]));
  const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
  const keep = { q: f.q, owner: f.owner, market: f.market, segment: f.segment, stage: f.stage, channel: f.channel, sort: f.sort, hide_hist: sget(sp, "hide_hist"), campaign: f.campaign, attention: f.attention };

  return (
    <div>
      <PageHeader title="Leads" sub={`${res.total} lead${res.total === 1 ? "" : "s"}${can(me, "leads.view_all") ? "" : " assigned to you"}`}>
        {can(me, "leads.export") && <Link href={`/export/leads${q(keep)}`} className="btn">Export CSV</Link>}
        {can(me, "leads.import") && <Link href="/leads/import" className="btn">Import CSV</Link>}
        {can(me, "leads.create") && <Link href="/leads/new" className="btn btn-primary">+ New lead</Link>}
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      {(f.attention || f.campaign) && (
        <div className="mb-3 rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          Showing {f.attention ? <b>{f.attention === "unanswered" ? "leads whose latest reply has no answer yet (last 30 days)" : "open leads with no open task and no activity for 7+ days"}</b> : "leads"}
          {f.campaign ? <> in campaign <b>{camps.find((c) => c.id === f.campaign)?.name ?? `#${f.campaign}`}</b></> : null}. <Link href="/leads">Show all leads</Link>
        </div>
      )}
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-56 flex-1"><label className="label">Search</label><input name="q" defaultValue={f.q} placeholder="Company, website, country, contact, email…" className="input" /></div>
        {can(me, "leads.view_all") && (
          <div><label className="label">Employee</label>
            <select name="owner" defaultValue={f.owner ?? ""} className="input"><option value="">All</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600" title="Companies kept only for past replies, bounces and opt-outs. Never outreach prospects."><input type="checkbox" name="hide_hist" value="1" defaultChecked={sget(sp, "hide_hist") === "1"} /> Hide historical-only</label>
        <div><label className="label">Campaign</label>
          <select name="campaign" defaultValue={f.campaign ?? ""} className="input"><option value="">All</option>{camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label className="label">Needs attention</label>
          <select name="attention" defaultValue={f.attention ?? ""} className="input"><option value="">All</option>{ATTENTION.map((a) => <option key={a} value={a}>{ATTENTION_LABEL[a]}</option>)}</select></div>
        <div><label className="label">Segment</label>
          <select name="segment" defaultValue={f.segment ?? ""} className="input"><option value="">All</option>{lists.segment.filter((i) => i.active).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></div>
        <div><label className="label">Market</label>
          <select name="market" defaultValue={f.market ?? ""} className="input"><option value="">All</option>{lists.market.filter((i) => i.active).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></div>
        <div><label className="label">Stage</label>
          <select name="stage" defaultValue={f.stage ?? ""} className="input"><option value="">All</option>{lists.stage.map((i) => <option key={i.key} value={i.key}>{i.label}{i.active ? "" : " (retired)"}</option>)}</select></div>
        <div><label className="label">Channel used</label>
          <select name="channel" defaultValue={f.channel ?? ""} className="input"><option value="">All</option>{lists.channel.filter((i) => i.active).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></div>
        <div><label className="label">Sort</label>
          <select name="sort" defaultValue={f.sort ?? ""} className="input"><option value="">Latest activity</option><option value="due">Next due</option><option value="company">Company A–Z</option></select></div>
        <button className="btn btn-primary">Filter</button>
        <Link href="/leads" className="btn">Reset</Link>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50"><tr>
            {["Company", "Campaign", "Owner", "Stage", "Last activity", "Next step"].map((h) => <th key={h} className="th">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {res.rows.map((l) => (
              <tr key={l.id} className="hover:bg-slate-50">
                <td className="td"><Link href={`/leads/${l.id}`} className="font-medium">{l.company}</Link> {l.is_demo ? <DemoBadge /> : null}
                  <div className="text-xs text-slate-500">{[l.domain, l.country, l.market ? markets[l.market] ?? l.market : null].filter(Boolean).join(" · ")}</div></td>
                <td className="td">{extra.campaigns.get(l.id)?.length ? extra.campaigns.get(l.id)!.map((c) => <div key={c.id}><Link href={`/leads${q({ ...keep, campaign: c.id })}`} className="text-slate-700">{c.name}</Link></div>) : l.historical_only ? <span className="text-slate-400">—</span> : <span className="text-amber-700">none</span>}</td>
                <td className="td">{l.owner_name ?? <span className="text-slate-400">Unassigned</span>}</td>
                <td className="td"><StageBadge stage={l.stage} label={stages[l.stage] ?? l.stage} flag={flag[l.stage]} /></td>
                <td className="td text-slate-600">{fmtShort(l.last_activity_at)}</td>
                <td className="td max-w-80">{(() => {
                  const t = extra.nextTask.get(l.id);
                  if (t) return (
                    <>
                      <div className="flex items-center gap-2"><Link href={`/tasks/${t.id}`} className="truncate font-medium">{t.title}</Link><Badge tone={STATE_TONE[t.state as keyof typeof STATE_TONE]}>{t.state}</Badge></div>
                      <div className="truncate text-xs text-slate-500">{t.assignee_name}{t.date_only ? ` · ${fmtYmd(t.on)}` : t.sort_at ? ` · ${fmtShort(t.sort_at)}` : " · no date"}{t.reason ? ` · ${t.reason}` : ""}</div>
                    </>
                  );
                  // No open task: fall back to the old free-text note, clearly marked as such.
                  if (l.next_action) return <><div className="truncate text-slate-600">{l.next_action}</div><div className={`text-xs ${isOverdue(l.next_due_at) ? "text-red-600" : "text-slate-400"}`}>old note, no task{l.next_due_at ? ` · ${fmtDate(l.next_due_at)}` : ""}</div></>;
                  return <span className="text-slate-400">nothing planned</span>;
                })()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {res.rows.length === 0 && <Empty>No leads match. {can(me, "leads.create") && <Link href="/leads/new">Add the first one</Link>}</Empty>}
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-500">Page {res.page} of {pages}</span>
          <div className="flex gap-2">
            {res.page > 1 && <Link className="btn btn-sm" href={`/leads${q({ ...keep, page: res.page - 1 })}`}>← Previous</Link>}
            {res.page < pages && <Link className="btn btn-sm" href={`/leads${q({ ...keep, page: res.page + 1 })}`}>Next →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
