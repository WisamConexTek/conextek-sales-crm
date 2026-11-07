"use client";
import { useActionState, useState } from "react";
import type { DateFixState } from "@/app/actions";

const TONE: Record<string, string> = { will_change: "text-emerald-700", changed: "text-emerald-700", unchanged: "text-slate-500", not_found: "text-amber-700", ambiguous: "text-amber-700", error: "text-red-700" };

export function DateFixForm({ action }: { action: (p: DateFixState, fd: FormData) => Promise<DateFixState> }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const counts = state && state.step !== "error" ? state.counts : null;
  const rows = state && state.step !== "error" ? state.rows : [];
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="text" value={text} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label">CSV file</label>
          <input type="file" accept=".csv,text/csv" className="input" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setName(f.name); setText(await f.text()); } }} />
        </div>
        <div><label className="label">Label (for the history)</label><input name="label" className="input" placeholder="e.g. Hunter export, March 2025" /></div>
        <button name="mode" value="preview" className="btn btn-primary" disabled={!text || pending}>{pending ? "Checking…" : "Check file (changes nothing)"}</button>
        {name && <span className="text-sm text-slate-500">{name}</span>}
      </div>
      {state?.step === "error" && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</div>}
      {counts && (
        <div className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4 text-sm">
            <div>
              <b>{state!.step === "done" ? counts.changed : counts.will_change}</b> {state!.step === "done" ? "corrected" : "will change"} · {counts.unchanged} already right · <b className="text-amber-700">{counts.not_found + counts.ambiguous}</b> not matched · <b className="text-red-700">{counts.errors}</b> errors
            </div>
            {state!.step === "preview" && (
              <button name="mode" value="commit" className="btn btn-primary" disabled={pending || counts.errors > 0 || counts.will_change === 0}>
                Apply {counts.will_change} correction{counts.will_change === 1 ? "" : "s"}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Row</th><th className="th">Lead</th><th className="th">Date now</th><th className="th">New date</th><th className="th">Result</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.index}>
                    <td className="td">{r.index + 2}</td>
                    <td className="td">{r.lead_id ? <a href={`/leads/${r.lead_id}`}>{r.company}</a> : "—"}</td>
                    <td className="td">{r.from ?? ""}</td><td className="td">{r.to ?? ""}</td>
                    <td className={`td ${TONE[r.status]}`}>{r.status.replace("_", " ")}{r.message ? ` — ${r.message}` : ""}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {state?.step === "done" && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">Done. Every change is in the audit history with the old and new date. Nothing was deleted or duplicated.</div>}
    </form>
  );
}
