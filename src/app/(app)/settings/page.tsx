import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, isManager } from "@/lib/auth";
import { listUsers, listKeys } from "@/lib/service/users";
import { getLists } from "@/lib/service/lists";
import { all, one } from "@/lib/db";
import { demoCount } from "@/lib/service/demo";
import { loadDemoAction, removeDemoAction, createUserAction, addListItemAction, updateListItemAction, moveListItemAction } from "@/app/actions";
import { SecretAction } from "@/components/SecretAction";
import { Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { LIST_KINDS, PRESETS } from "@/lib/constants";
import { q, sget, snum, type SP } from "@/lib/view";

export default async function Settings({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  if (!isManager(me)) redirect("/");
  const sp = await searchParams;
  const owner = me.role === "owner";
  const tab = sget(sp, "tab") === "lists" && owner ? "lists" : sget(sp, "tab") === "history" ? "history" : "team";
  const tabs: [string, string][] = [["team", "Team & permissions"], ...(owner ? [["lists", "Lists & stages"] as [string, string]] : []), ["history", "Change history"]];

  return (
    <div className="space-y-5">
      <PageHeader title="Settings & Permissions" sub={owner ? "Full owner access" : "Chief: you can adjust employee permissions and reset their passwords"} />
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(([k, l]) => <Link key={k} href={`/settings?tab=${k}`} className={`-mb-px border-b-2 px-4 py-2 text-sm no-underline hover:no-underline ${tab === k ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-slate-600"}`}>{l}</Link>)}
      </div>
      {tab === "team" && <Team owner={owner} />}
      {tab === "lists" && owner && <Lists />}
      {tab === "history" && <History page={snum(sp, "page") ?? 1} action={sget(sp, "action")} />}
    </div>
  );
}

async function Team({ owner }: { owner: boolean }) {
  const [users, keys] = await Promise.all([listUsers(), listKeys()]);
  return (
    <>
      <Card title={`Team (${users.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="border-b border-slate-200"><tr>{["Name", "Username", "Role", "Preset", "Permissions", "API keys", "Last login", "Status"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => {
                const k = keys.filter((x) => x.user_id === u.id && x.active && !x.revoked_at).length;
                return (
                  <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                    <td className="td"><Link href={`/settings/users/${u.id}`} className="font-medium">{u.name}</Link></td>
                    <td className="td text-slate-600">{u.username}</td>
                    <td className="td capitalize">{u.role}</td>
                    <td className="td">{PRESETS[u.preset]?.label ?? u.preset ?? "Custom"}</td>
                    <td className="td">{u.role === "owner" ? "All" : u.perms.length}</td>
                    <td className="td">{k}</td>
                    <td className="td text-slate-600">{u.last_login_at ? fmtDateTime(u.last_login_at) : "Never"}</td>
                    <td className="td">{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Disabled</Badge>}{u.must_change_password ? <> <Badge tone="amber">Temp password</Badge></> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {owner && (
        <Card title="Add a team member">
          <SecretAction action={createUserAction} submit="Create account" className="grid max-w-3xl gap-3 md:grid-cols-4" secretLabel="Share it securely — they must change it at first login.">
            <Field label="Name"><input name="name" className="input" required /></Field>
            <Field label="Username"><input name="username" className="input" required pattern="[a-zA-Z0-9._\-]+" minLength={3} /></Field>
            <Field label="Role"><select name="role" className="input"><option value="employee">Employee</option><option value="chief">Chief</option></select></Field>
            <Field label="Permission preset"><select name="preset" className="input" defaultValue="researcher">{Object.entries(PRESETS).filter(([k]) => k !== "owner").map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select></Field>
          </SecretAction>
          <p className="mt-3 text-xs text-slate-500">After creating the account, open it to issue the employee's API key and fine-tune permissions. New people can be added any time — nothing else needs to change.</p>
        </Card>
      )}
    </>
  );
}

async function Lists() {
  const lists = await getLists(true);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {LIST_KINDS.map(({ kind, title, hint }) => (
        <Card key={kind} title={title}>
          {hint && <p className="mb-3 text-xs text-slate-500">{hint}</p>}
          <ul className="space-y-1.5">
            {lists[kind].map((it, i) => (
              <li key={it.id} className={`flex items-center gap-2 ${it.active ? "" : "opacity-60"}`}>
                <form action={updateListItemAction} className="flex flex-1 items-center gap-2">
                  <input type="hidden" name="_back" value="/settings?tab=lists" /><input type="hidden" name="id" value={it.id} />
                  <input name="label" defaultValue={it.label} className="input py-1" />
                  {kind === "stage" && <select name="flag" defaultValue={it.flag ?? ""} className="input w-28 py-1 text-xs"><option value="">No flag</option><option value="won">Won</option><option value="lost">Lost</option><option value="meeting">Meeting</option><option value="replied">Replied</option><option value="closed">Closed</option></select>}
                  {kind === "task_type" && <select name="flag" defaultValue={it.flag ?? "chief"} className="input w-32 py-1 text-xs"><option value="chief">Chief approves</option><option value="wisam">Wisam approves</option></select>}
                  <select name="active" defaultValue={it.active ? "1" : "0"} className="input w-24 py-1 text-xs"><option value="1">Active</option><option value="0">Retired</option></select>
                  <button className="btn btn-sm">Save</button>
                </form>
                <form action={moveListItemAction} className="flex"><input type="hidden" name="_back" value="/settings?tab=lists" /><input type="hidden" name="id" value={it.id} />
                  <button name="dir" value="-1" className="btn btn-sm px-1.5" disabled={i === 0} aria-label="Move up">↑</button>
                  <button name="dir" value="1" className="btn btn-sm px-1.5" disabled={i === lists[kind].length - 1} aria-label="Move down">↓</button></form>
              </li>
            ))}
          </ul>
          <form action={addListItemAction} className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
            <input type="hidden" name="_back" value="/settings?tab=lists" /><input type="hidden" name="kind" value={kind} />
            <input name="label" placeholder="Add new…" className="input" required />
            {kind === "stage" && <select name="flag" className="input w-28 text-xs"><option value="">No flag</option><option value="won">Won</option><option value="lost">Lost</option><option value="meeting">Meeting</option><option value="replied">Replied</option><option value="closed">Closed</option></select>}
            {kind === "task_type" && <select name="flag" className="input w-32 text-xs"><option value="chief">Chief approves</option><option value="wisam">Wisam approves</option></select>}
            <button className="btn btn-primary">Add</button>
          </form>
          <p className="mt-2 text-xs text-slate-400">Retiring an item hides it from new records but keeps existing records intact.</p>
        </Card>
      ))}
      <Card title="Demo data">
        <p className="mb-3 text-sm text-slate-600">Production starts empty. Demo records are labelled DEMO, hidden unless you switch them on, and never counted in the dashboard or reports.</p>
        <form action={(await demoCount()) ? removeDemoAction : loadDemoAction}><input type="hidden" name="_back" value="/settings?tab=lists" />
          <button className={`btn ${(await demoCount()) ? "btn-danger" : ""}`}>{(await demoCount()) ? "Remove all demo data" : "Load demo data"}</button></form>
      </Card>
      <Card title="Fixed lists">
        <p className="text-sm text-slate-600">Task statuses (To do → Cancelled) and activity outcomes (Sent, Reply received, Bounced, No response yet, Opted out) are fixed because reports and approval rules depend on them.</p>
      </Card>
    </div>
  );
}

async function History({ page, action }: { page: number; action?: string }) {
  const size = 100;
  const where = action ? "WHERE action LIKE ?" : "";
  const args = action ? [`%${action}%`] : [];
  const total = Number((await one(`SELECT COUNT(*) n FROM audit_log ${where}`, args))!.n);
  const rows = await all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
  const pages = Math.max(1, Math.ceil(total / size));
  const brief = (d: string | null) => (d ? (d.length > 220 ? d.slice(0, 220) + "…" : d) : "");
  return (
    <Card title={`Change history (${total}) — read-only`} right={
      <form className="flex gap-2"><input type="hidden" name="tab" value="history" /><input name="action" defaultValue={action} placeholder="Filter action…" className="input w-44 py-1" /><button className="btn btn-sm">Filter</button></form>
    }>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="border-b border-slate-200"><tr>{["When", "Who", "Via", "Action", "Record", "Detail"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}><td className="td whitespace-nowrap text-slate-600">{fmtDateTime(r.created_at)}</td><td className="td">{r.actor_name}</td>
                <td className="td"><Badge tone={r.via === "api" ? "purple" : "gray"}>{r.via}</Badge></td><td className="td font-medium">{r.action.replaceAll("_", " ")}</td>
                <td className="td text-slate-600">{r.entity} {r.entity_id ? `#${r.entity_id}` : ""}</td><td className="td max-w-md break-words font-mono text-xs text-slate-500">{brief(r.detail)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm"><span className="text-slate-500">Page {page} of {pages}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn btn-sm" href={`/settings${q({ tab: "history", action, page: page - 1 })}`}>← Newer</Link>}{page < pages && <Link className="btn btn-sm" href={`/settings${q({ tab: "history", action, page: page + 1 })}`}>Older →</Link>}</div></div>
      )}
    </Card>
  );
}
