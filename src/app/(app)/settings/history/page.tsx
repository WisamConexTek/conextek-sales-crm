import Link from "next/link";
import { requireUser, requirePerm } from "@/lib/auth";
import { dateStatus, recentBatches } from "@/lib/service/history";
import { dateFixAction } from "@/app/actions";
import { DateFixForm } from "@/components/DateFixForm";
import { Card, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function HistoryPage() {
  const me = await requireUser();
  requirePerm(me, "history.import");
  const [st, batches] = await Promise.all([dateStatus(), recentBatches(15)]);
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Historical data & lead dates" sub="Keep the real date of each lead separate from the day it was entered into the CRM." />
      <Card title="Where things stand">
        <p className="text-sm text-slate-700">
          <b>{st.unknown}</b> of {st.total} real leads have <b>no known original date</b>. They are not counted in daily/weekly/monthly or custom-period numbers (we never assume “today”), but they appear under <Link href="/reports?all=1">All data</Link>.
          Fix them below from your source files; leads that already have a date are only changed if the file says something different.
        </p>
      </Card>
      <Card title="Correct original lead dates in bulk (CSV)">
        <p className="mb-3 text-sm text-slate-600">
          One row per lead. Columns: <code>lead_date</code> (YYYY-MM-DD, or YYYY-MM-DDTHH:mm; <code>unknown</code> clears it) and <b>one</b> way to find the lead: <code>id</code>, <code>external_id</code>, <code>website</code> or <code>company</code>.
          Optional <code>employee</code> (username) sets who originally found the lead. Existing leads are only updated — nothing is created, deleted or duplicated, and the date it was entered stays as it is.
          Check the file first; you apply it only after reviewing the result.
        </p>
        <DateFixForm action={dateFixAction} />
      </Card>
      <Card title="Importing past outreach (leads, sends, replies, bounces)">
        <p className="text-sm text-slate-600">
          Done through the API so your agents or scripts can send the historical log in chunks: <code>POST /api/v1/import/history</code>. It checks first (dry run), skips duplicates, keeps do-not-contact/bounced states, and records the original employee separately from the person importing.
          Full field list and examples are in the <Link href="/api-docs#history">API guide</Link>. The Owner can grant the “history.import” permission to a trusted API key.
        </p>
      </Card>
      <Card title="Recent imports and corrections">
        {batches.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
          <table className="w-full text-sm"><thead><tr><th className="th">#</th><th className="th">Kind</th><th className="th">Label</th><th className="th">By</th><th className="th">When</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{batches.map((b) => <tr key={b.id}><td className="td">{b.id}</td><td className="td">{b.kind === "date_fix" ? "Date correction" : "Historical import"}</td><td className="td">{b.label}</td><td className="td">{b.imported_by_name}</td><td className="td">{fmtDateTime(b.created_at)}</td></tr>)}</tbody></table>
        )}
      </Card>
    </div>
  );
}
