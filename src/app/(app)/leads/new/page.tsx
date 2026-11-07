import { requireUser, requirePerm, can } from "@/lib/auth";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import { createLeadAction } from "@/app/actions";
import { Card, Field, Flash, Opts, PageHeader } from "@/components/ui";
import { sget, type SP } from "@/lib/view";

export default async function NewLead({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  requirePerm(me, "leads.create");
  const sp = await searchParams;
  const [lists, users] = await Promise.all([getLists(), assignableUsers()]);
  const L = (k: string) => lists[k].map((i) => ({ key: i.key, label: i.label }));
  const dup = sget(sp, "dup");
  return (
    <div className="max-w-4xl">
      <PageHeader title="New lead" sub="The CRM warns about duplicates by website, company name and contact email." />
      <Flash err={sget(sp, "err")} />
      <form action={createLeadAction} className="space-y-5">
        <input type="hidden" name="_back" value="/leads/new" />
        <Card title="Company">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Company name *"><input name="company" className="input" required /></Field>
            <Field label="Website"><input name="website" className="input" placeholder="https://" /></Field>
            <Field label="Industry"><select name="industry" className="input"><Opts items={L("industry")} empty="—" /></select></Field>
            <Field label="Country"><input name="country" className="input" /></Field>
            <Field label="Target market (geography)"><select name="market" className="input"><Opts items={L("market")} empty="—" /></select></Field>
            <Field label="Customer segment"><select name="segment" className="input"><Opts items={L("segment")} empty="—" /></select></Field>
            <Field label="Preferred language"><select name="language" className="input"><Opts items={L("language")} empty="—" /></select></Field>
            <Field label="Lead source"><select name="source" className="input"><Opts items={L("source")} empty="—" /></select></Field>
            <Field label="Source link"><input name="source_url" className="input" placeholder="https://" /></Field>
            <Field label="Service of interest"><select name="service" className="input"><Opts items={L("service")} empty="—" /></select></Field>
            <Field label="Assigned employee">
              <select name="owner_id" className="input" defaultValue={can(me, "tasks.assign") ? "" : me.id} disabled={!can(me, "tasks.assign")}>
                {can(me, "tasks.assign") ? <><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</> : <option value={me.id}>{me.name}</option>}
              </select>
              {!can(me, "tasks.assign") && <input type="hidden" name="owner_id" value={me.id} />}
            </Field>
            <Field label="Stage"><select name="stage" className="input"><Opts items={L("stage")} /></select></Field>
            <Field label="Next action" className="md:col-span-2"><input name="next_action" className="input" /></Field>
            <Field label="Due"><input type="date" name="next_due_at" className="input" /></Field>
            <Field label="Notes" className="md:col-span-3"><textarea name="notes" className="input" /></Field>
          </div>
        </Card>
        <Card title="First contact (more can be added later)">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name"><input name="contact_name" className="input" /></Field>
            <Field label="Role"><input name="contact_role" className="input" /></Field>
            <Field label="Email"><input name="contact_email" type="email" className="input" /></Field>
            <Field label="Phone"><input name="contact_phone" className="input" /></Field>
            <Field label="LinkedIn"><input name="contact_linkedin" className="input" placeholder="https://linkedin.com/in/…" /></Field>
            <Field label="Other social link"><input name="contact_other_social" className="input" /></Field>
          </div>
        </Card>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary">Create lead</button>
          <label className="flex items-center gap-2 text-sm text-slate-700" title="Test leads are labelled TEST and never counted in the dashboard or reports">
            <input type="checkbox" name="is_test" /> This is test data
          </label>
          {dup && (
            <label className="flex items-center gap-2 text-sm text-amber-800">
              <input type="checkbox" name="allow_duplicate" /> This is a different lead — create it anyway
            </label>
          )}
        </div>
      </form>
    </div>
  );
}
