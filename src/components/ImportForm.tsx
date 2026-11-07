"use client";
import { useActionState, useState } from "react";
import type { ImportState } from "@/app/actions";

export function ImportForm({ action }: { action: (p: ImportState, fd: FormData) => Promise<ImportState> }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const rows = state?.step === "preview" ? state.rows : [];
  const counts = { ok: rows.filter((r) => r.status === "ok").length, dup: rows.filter((r) => r.status === "duplicate").length, err: rows.filter((r) => r.status === "error").length };

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="text" value={text} />
      <div className="card p-4">
        <label className="label">CSV file</label>
        <input type="file" accept=".csv,text/csv" className="input" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) { setName(f.name); setText(await f.text()); }
        }} />
        <p className="mt-2 text-xs text-slate-500">
          Header row required. Recognised columns: company*, website, industry, country, market, language, source, source_url, owner (username), stage, service, notes, next_action, next_due, contact_name, contact_role, contact_email, contact_phone, linkedin. Max 500 rows per file.
        </p>
        <button name="mode" value="preview" className="btn btn-primary mt-3" disabled={!text || pending}>{pending ? "Checking…" : "Check file"}</button>
        {name && <span className="ml-3 text-sm text-slate-500">{name}</span>}
      </div>

      {state?.step === "error" && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</div>}

      {state?.step === "preview" && (
        <div className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <div className="text-sm"><b>{counts.ok}</b> ready · <b className="text-amber-700">{counts.dup}</b> possible duplicates · <b className="text-red-700">{counts.err}</b> errors
              {state.unknownColumns.length > 0 && <span className="ml-2 text-slate-500">Ignored columns: {state.unknownColumns.join(", ")}</span>}</div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="dups" /> Also import duplicates</label>
              <button name="mode" value="commit" className="btn btn-primary" disabled={pending}>Import {counts.ok} lead{counts.ok === 1 ? "" : "s"}</button>
            </div>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm"><thead className="sticky top-0 bg-slate-50"><tr><th className="th">Line</th><th className="th">Company</th><th className="th">Status</th><th className="th">Notes</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{rows.map((r) => (
                <tr key={r.line}><td className="td">{r.line}</td><td className="td font-medium">{r.company}</td>
                  <td className="td"><span className={r.status === "ok" ? "text-emerald-700" : r.status === "duplicate" ? "text-amber-700" : "text-red-700"}>{r.status}</span></td>
                  <td className="td text-xs text-slate-600">{r.messages.join("; ")}</td></tr>))}</tbody></table>
          </div>
        </div>
      )}

      {state?.step === "done" && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Imported <b>{state.created}</b> lead(s). Skipped {state.skipped} duplicate(s). Failed {state.failed}.
          {state.errors.length > 0 && <ul className="mt-2 list-disc pl-5 text-red-800">{state.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <div className="mt-2"><a href="/leads">View leads →</a></div>
        </div>
      )}
    </form>
  );
}
