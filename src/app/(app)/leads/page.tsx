import Link from "next/link";
import { requireUser, can } from "@/lib/auth";
import { listLeads } from "@/lib/service/leads";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import { PageHeader, Flash, StageBadge, DemoBadge, Empty } from "@/components/ui";
import { fmtDate, fmtShort, isOverdue } from "@/lib/format";
import { demoOn, q, sget, snum, type SP } from "@/lib/view";

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const f = { q: sget(sp, "q"), owner: snum(sp, "owner"), market: sget(sp, "market"), segment: sget(sp, "segment"), stage: sget(sp, "stage"), channel: sget(sp, "channel"), sort: sget(sp, "sort"), page: snum(sp, "page") ?? 1 };
  const [res, lists, users] = await Promise.all([listLeads(me, { ...f, includeDemo: await demoOn(), includeHistorical: sget(sp, "hide_hist") !== "1" }), getLists(true), assignableUsers()]);
  const label = (kind: string) => Object.fromEntries(lists[kind].map((i) => [i.key, i.label]));
  const stages = label("stage"), markets = label("market");
  const flag = Object.fromEntries(lists.stage.map((i) => [i.key, i.flag]));
  const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
  const keep = { q: f.q, owner: f.owner, market: f.market, segment: f.segment, stage: f.stage, channel: f.channel, sort: f.sort, hide_hist: sget(sp, "hide_hist") };

  return (
    <div>
      <PageHeader title="Leads" sub={`${res.total} lead${res.total === 1 ? "" : "s"}${can(me, "leads.view_all") ? "" : " assigned to you"}`}>
        {can(me, "leads.export") && <Link href={`/export/leads${q(keep)}`} className="btn">Export CSV</Link>}
        {can(me, "leads.import") && <Link href="/leads/import" className="btn">Import CSV</Link>}
        {can(me, "leads.create") && <Link href="/leads/new" className="btn btn-primary">+ New lead</Link>}
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-56 flex-1"><label className="label">Search</label><input name="q" defaultValue={f.q} placeholder="Company, website, country, contact, email…" className="input" /></div>
        {can(me, "leads.view_all") && (
          <div><label className="label">Employee</label>
            <select name="owner" defaultValue={f.owner ?? ""} className="input"><option value="">All</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600" title="Companies kept only for past replies, bounces and opt-outs. Never outreach prospects."><input type="checkbox" name="hide_hist" value="1" defaultChecked={sget(sp, "hide_hist") === "1"} /> Hide historical-only</label>
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
            {["Company", "Country", "Owner", "Stage", "Last activity", "Next action", "Due"].map((h) => <th key={h} className="th">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {res.rows.map((l) => (
              <tr key={l.id} className="hover:bg-slate-50">
                <td className="td"><Link href={`/leads/${l.id}`} className="font-medium">{l.company}</Link> {l.is_demo ? <DemoBadge /> : null}
                  <div className="text-xs text-slate-500">{l.domain ?? ""}{l.market ? ` · ${markets[l.market] ?? l.market}` : ""}</div></td>
                <td className="td">{l.country ?? "—"}</td>
                <td className="td">{l.owner_name ?? <span className="text-slate-400">Unassigned</span>}</td>
                <td className="td"><StageBadge stage={l.stage} label={stages[l.stage] ?? l.stage} flag={flag[l.stage]} /></td>
                <td className="td text-slate-600">{fmtShort(l.last_activity_at)}</td>
                <td className="td max-w-64 truncate">{l.next_action ?? <span className="text-slate-400">—</span>}</td>
                <td className={`td whitespace-nowrap ${isOverdue(l.next_due_at) ? "font-medium text-red-600" : ""}`}>{l.next_due_at ? fmtDate(l.next_due_at) : "—"}</td>
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
