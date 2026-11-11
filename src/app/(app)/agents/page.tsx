import Link from "next/link";
import { requireUser, isManager } from "@/lib/auth";
import { agentSummary, listRequests, listRuns } from "@/lib/service/agents";
import { assignableUsers } from "@/lib/service/users";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { fmtDateTime, fmtShort, fmtTime } from "@/lib/format";
import { q, sget, snum, type SP } from "@/lib/view";

const OUTCOME_TONE = { ok: "green", refused: "amber", error: "red", replayed: "blue" } as const;
const OUTCOME_LABEL = { ok: "Done", refused: "Refused", error: "Error", replayed: "Repeat (nothing changed)" } as const;
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? "just now" : m < 60 ? `${Math.floor(m)} min ago` : m < 2880 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};
const span = (a: string, b: string) => {
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${(s / 3600).toFixed(1)}h`;
};

/** Every step an agent takes through the API or MCP: reads, changes and refusals, newest first; one run as a timeline. */
export default async function AgentActivity({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const mgr = isManager(me);
  const run = sget(sp, "run");
  const f = { actor: snum(sp, "actor"), outcome: sget(sp, "outcome"), kind: sget(sp, "kind"), run, lead: snum(sp, "lead"), task: snum(sp, "task"), q: sget(sp, "q"), from: sget(sp, "from"), to: sget(sp, "to"), page: snum(sp, "page") ?? 1 };
  const safe = { ...f, outcome: f.outcome && f.outcome in OUTCOME_TONE ? f.outcome : undefined };
  const [res, summary, runs, users] = await Promise.all([
    listRequests(me, { ...safe, pageSize: run ? 500 : 100, oldestFirst: !!run }),
    agentSummary(me), listRuns(me, 8), mgr ? assignableUsers() : Promise.resolve([]),
  ]);
  const keep = { actor: f.actor, outcome: safe.outcome, kind: f.kind, run, lead: f.lead, task: f.task, q: f.q, from: f.from, to: f.to };
  const pages = Math.max(1, Math.ceil(res.total / res.page_size));
  const filtered = Object.values(keep).some(Boolean);

  return (
    <div className="space-y-5">
      <PageHeader title="Agent activity" sub={mgr ? "Every step taken through the API or MCP: what was read, what was changed, and what the CRM refused." : "Every step your API keys took."}>
        <Link href="/api-docs" className="btn">API guide</Link>
      </PageHeader>

      {!run && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {summary.length === 0 && <div className="card p-4 text-sm text-slate-500 sm:col-span-2 xl:col-span-4">No account has used the API yet. Issue a key in Settings, and mark agent accounts as “AI agent” there so they are listed here.</div>}
          {summary.map((a) => (
            <Link key={a.id} href={`/agents${q({ actor: a.id })}`} className={`card block p-4 no-underline hover:border-slate-300 hover:no-underline ${f.actor === a.id ? "ring-2 ring-brand-500" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-900">{a.name}</div><div className="text-xs text-slate-500">last step {ago(a.lastAt)}</div></div>
                {a.isAgent ? <Badge tone="purple">AI agent</Badge> : <Badge tone="gray">Person</Badge>}
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                {([["Steps", a.steps, ""], ["Changes", a.changes, ""], ["Refused", a.refused, "text-amber-700"], ["Errors", a.errors, "text-red-700"]] as const).map(([l, n, c]) => (
                  <div key={l}><div className={`text-lg font-semibold leading-none ${n ? c || "text-slate-900" : "text-slate-400"}`}>{n}</div><div className="mt-1 text-[11px] text-slate-500">{l}</div></div>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">last 24 hours</div>
            </Link>
          ))}
        </div>
      )}

      {!run && runs.length > 0 && (
        <Card title="Latest runs" right={<span className="text-xs text-slate-500">calls that share an X-Run-Id</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200"><tr>{["Run", "Who", "Started", "Lasted", "Steps", "Changes", "Refused", "Errors"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {runs.map((r) => (
                  <tr key={r.runId}>
                    <td className="td"><Link href={`/agents${q({ run: r.runId })}`} className="font-mono text-xs font-medium">{r.runId}</Link></td>
                    <td className="td">{r.who ?? "—"}</td><td className="td whitespace-nowrap text-slate-600">{fmtShort(r.started)}</td><td className="td">{span(r.started, r.ended)}</td>
                    <td className="td">{r.steps}</td><td className="td">{r.changes}</td>
                    <td className={`td ${r.refused ? "font-semibold text-amber-700" : "text-slate-400"}`}>{r.refused}</td><td className={`td ${r.errors ? "font-semibold text-red-700" : "text-slate-400"}`}>{r.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {run && (
        <div className="rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          Run <span className="font-mono font-semibold">{run}</span>: {res.total} step{res.total === 1 ? "" : "s"}, in the order they happened
          {res.rows.length > 1 ? ` (${span(res.rows[0].at, res.rows[res.rows.length - 1].at)})` : ""}. <Link href="/agents">Back to all activity</Link>
        </div>
      )}

      <form className="card flex flex-wrap items-end gap-3 p-3">
        {run && <input type="hidden" name="run" value={run} />}
        {mgr && <div><label className="label" htmlFor="ag-actor">Account</label><select id="ag-actor" name="actor" defaultValue={f.actor ?? ""} className="input"><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
        <div><label className="label" htmlFor="ag-out">Result</label><select id="ag-out" name="outcome" defaultValue={safe.outcome ?? ""} className="input"><option value="">All</option><option value="ok">Done</option><option value="refused">Refused by the CRM</option><option value="error">Error</option><option value="replayed">Repeat</option></select></div>
        <div><label className="label" htmlFor="ag-kind">Type</label><select id="ag-kind" name="kind" defaultValue={f.kind ?? ""} className="input"><option value="">Reads and changes</option><option value="write">Changes only</option><option value="read">Reads only</option></select></div>
        <div><label className="label" htmlFor="ag-lead">Lead #</label><input id="ag-lead" name="lead" defaultValue={f.lead ?? ""} className="input w-24" inputMode="numeric" /></div>
        <div><label className="label" htmlFor="ag-from">From</label><input id="ag-from" type="date" name="from" defaultValue={f.from} className="input" /></div>
        <div><label className="label" htmlFor="ag-to">To</label><input id="ag-to" type="date" name="to" defaultValue={f.to} className="input" /></div>
        <div className="min-w-40 flex-1"><label className="label" htmlFor="ag-q">Search</label><input id="ag-q" name="q" defaultValue={f.q} placeholder="path, error text or code…" className="input" /></div>
        <button className="btn btn-primary">Filter</button>
        {filtered && <Link href="/agents" className="btn">Reset</Link>}
      </form>

      <Card title={`${run ? "Steps" : "All steps"} (${res.total})`} right={<span className="text-xs text-slate-500">{run ? "oldest first" : "newest first"}</span>}>
        {res.rows.length === 0 ? <Empty>{filtered ? "No steps match these filters." : "Nothing has come in through the API yet."}</Empty> : (
          <ol className="divide-y divide-slate-100">
            {res.rows.map((r, i) => (
              <li key={r.id} className="py-2.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {run && <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">{(res.page - 1) * res.page_size + i + 1}</span>}
                      <span className="font-medium text-slate-900">{r.step}</span>
                      <Badge tone={OUTCOME_TONE[r.outcome as keyof typeof OUTCOME_TONE] ?? "gray"}>{OUTCOME_LABEL[r.outcome as keyof typeof OUTCOME_LABEL] ?? r.outcome}</Badge>
                      {r.kind === "write" && r.outcome === "ok" && <Badge tone="purple">changed data</Badge>}
                      {r.via === "mcp" && <Badge tone="sky">MCP</Badge>}
                    </div>
                    <div className={`mt-0.5 text-xs text-slate-500 ${run ? "pl-8" : ""}`}>
                      <code className="rounded bg-slate-100 px-1">{r.method} {r.path}{r.query ? `?${r.query}` : ""}</code>
                      {r.lead_id ? <> · <Link href={`/leads/${r.lead_id}`}>{r.company ?? `lead #${r.lead_id}`}</Link></> : null}
                      {r.task_id ? <> · <Link href={`/tasks/${r.task_id}`}>task #{r.task_id}</Link></> : null}
                      {r.message_version_id ? <> · message version #{r.message_version_id}</> : null}
                    </div>
                    {r.error && <div className={`mt-1 rounded border px-2 py-1 text-xs ${run ? "ml-8" : ""} ${r.outcome === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{r.error_code ? <b>{r.error_code}: </b> : null}{r.error}</div>}
                    {(r.request_body || r.result) && (
                      <details className={`mt-1 text-xs ${run ? "pl-8" : ""}`}>
                        <summary className="text-slate-500">Details</summary>
                        {r.request_body && <><div className="mt-1 font-medium text-slate-600">Sent</div><pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-slate-700" dir="auto">{r.request_body}</pre></>}
                        {r.result && <><div className="mt-1 font-medium text-slate-600">Came back</div><pre className="mt-0.5 whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-slate-700" dir="auto">{r.result}</pre></>}
                      </details>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs text-slate-500">
                    <div className="font-medium text-slate-700">{r.actor_name ?? "No valid key"}{r.is_agent ? <> <Badge tone="purple">AI</Badge></> : null}</div>
                    <div title={fmtDateTime(r.at)}>{run ? fmtTime(r.at) : fmtShort(r.at)} · {r.duration_ms} ms</div>
                    {r.key_label && <div className="text-slate-400">key: {r.key_label}</div>}
                    {!run && r.run_id && <Link href={`/agents${q({ run: r.run_id })}`} className="font-mono">run {String(r.run_id).slice(0, 18)}</Link>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-sm"><span className="text-slate-500">Page {res.page} of {pages}</span>
            <div className="flex gap-2">{res.page > 1 && <Link className="btn btn-sm" href={`/agents${q({ ...keep, page: res.page - 1 })}`}>← {run ? "Earlier" : "Newer"}</Link>}{res.page < pages && <Link className="btn btn-sm" href={`/agents${q({ ...keep, page: res.page + 1 })}`}>{run ? "Later" : "Older"} →</Link>}</div></div>
        )}
      </Card>
      <p className="text-xs text-slate-400">One row per call, written whatever the result. “Refused” means a CRM rule stopped the call (the reason is shown). Agents group their calls into a run by sending the header X-Run-Id.</p>
    </div>
  );
}
