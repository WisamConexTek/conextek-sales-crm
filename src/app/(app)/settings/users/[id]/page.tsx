import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser, isManager } from "@/lib/auth";
import { getUser, listKeys, canManageKeysFor, CHIEF_LOCKED } from "@/lib/service/users";
import {
  updateUserAction, setPermsAction, applyPresetAction, resetPasswordAction, createKeyAction, keyToggleAction, keyRevokeAction, setMigrationAccessAction,
} from "@/app/actions";
import { SecretAction } from "@/components/SecretAction";
import { Badge, Card, Field, Flash, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { PERMISSIONS, PRESETS, ALL_PERMISSIONS } from "@/lib/constants";
import { can } from "@/lib/auth";
import { sget, type SP } from "@/lib/view";

export default async function UserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const me = await requireUser();
  if (!isManager(me)) redirect("/");
  const { id } = await params;
  const u = await getUser(Number(id));
  if (!u) notFound();
  const sp = await searchParams;
  const owner = me.role === "owner";
  const back = `/settings/users/${u.id}`;
  const canKeys = canManageKeysFor(me, u);
  const keys = canKeys ? await listKeys(u.id, me) : [];
  const isOwnerAcct = u.role === "owner";
  const editablePerms = owner ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((p) => can(me, p) && !CHIEF_LOCKED.includes(p));
  const canEditPerms = !isOwnerAcct && (owner || (me.role === "chief" && u.role === "employee"));
  const canReset = owner ? !isOwnerAcct || u.id === me.id : me.role === "chief" && u.role === "employee";

  return (
    <div className="max-w-5xl space-y-5">
      <div className="text-sm"><Link href="/settings">← Settings</Link></div>
      <PageHeader title={u.name} sub={`${u.username} · ${u.role}${u.active ? "" : " · disabled"}`} />
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      {owner && (
        <Card title="Account">
          <form action={updateUserAction} className="grid max-w-3xl gap-3 md:grid-cols-4">
            <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={u.id} />
            <Field label="Name"><input name="name" defaultValue={u.name} className="input" /></Field>
            <Field label="Role"><select name="role" defaultValue={u.role} className="input" disabled={isOwnerAcct}>{isOwnerAcct ? <option value="owner">Owner</option> : <><option value="employee">Employee</option><option value="chief">Chief</option></>}</select></Field>
            <Field label="Status"><select name="active" defaultValue={u.active ? "1" : "0"} className="input" disabled={isOwnerAcct}><option value="1">Active</option><option value="0">Disabled (cannot sign in; API keys stop working)</option></select></Field>
            <div className="flex items-end"><button className="btn btn-primary">Save</button></div>
          </form>
        </Card>
      )}

      {owner && !isOwnerAcct && (
        <Card title="Migration access (historical import)" right={u.history_import_until && u.history_import_until > new Date().toISOString() ? <Badge tone="green">Active until {fmtDateTime(u.history_import_until)}</Badge> : <Badge tone="gray">Not granted</Badge>}>
          <p className="mb-3 text-sm text-slate-600">
            Lets this person (with their own login or API key) use only the historical-import, lead-date-correction and activity-reconcile endpoints — dry run first. It does <b>not</b> give permission management, Owner functions or any way to send messages.
            Access switches itself off at the end of the period; you can revoke it earlier.
          </p>
          <form action={setMigrationAccessAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={u.id} />
            <button name="hours" value="24" className="btn">Grant for 24 hours</button>
            <button name="hours" value="168" className="btn">Grant for 7 days</button>
            <button name="hours" value="720" className="btn">Grant for 30 days</button>
            <button name="hours" value="revoke" className="btn text-red-700">Revoke now</button>
          </form>
        </Card>
      )}

      <Card title="Permissions" right={isOwnerAcct ? <Badge tone="purple">Owner — always full access</Badge> : null}>
        {!canEditPerms ? <p className="text-sm text-slate-500">{isOwnerAcct ? "The owner always has full access." : "You can't change this person's permissions."}</p> : (
          <>
            <form action={applyPresetAction} className="mb-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={u.id} />
              <Field label="Apply a preset"><select name="preset" className="input" defaultValue={u.preset ?? ""}>{Object.entries(PRESETS).filter(([k, p]) => k !== "owner" && (owner || p.role === "employee")).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select></Field>
              <button className="btn">Apply preset</button>
              <span className="text-xs text-slate-500">Presets replace the toggles below, which you can then fine-tune.</span>
            </form>
            <form action={setPermsAction}>
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={u.id} />
              <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
                {ALL_PERMISSIONS.map((p) => {
                  const on = u.perms.includes(p);
                  const locked = !editablePerms.includes(p);
                  return (
                    <label key={p} className={`flex items-start gap-2 text-sm ${locked ? "opacity-50" : ""}`}>
                      <input type="checkbox" name={`perm:${p}`} defaultChecked={on} disabled={locked} className="mt-0.5" />
                      <span><span className="font-medium">{PERMISSIONS[p]}</span><span className="block font-mono text-xs text-slate-400">{p}{locked ? " · owner-only" : ""}</span></span>
                    </label>
                  );
                })}
              </div>
              <button className="btn btn-primary mt-4">Save permissions</button>
            </form>
          </>
        )}
        <p className="mt-3 text-xs text-slate-500">Permissions apply equally to the web interface and to this person's API keys. Nobody can approve their own submission, regardless of permissions. Items that need Wisam can only be decided by the owner.</p>
      </Card>

      {canReset && (
        <Card title="Password">
          <SecretAction action={resetPasswordAction} submit="Reset password" secretLabel="Give it to them securely. They can change it under Account.">
            <input type="hidden" name="id" value={u.id} />
            <p className="mb-2 text-sm text-slate-600">Set a new password for this person. Existing sessions are signed out.</p>
            <Field label="New password (min 10 chars, blank = generate)"><input name="password" type="text" autoComplete="off" minLength={10} className="input max-w-sm" /></Field>
          </SecretAction>
        </Card>
      )}

      {canKeys && (
        <Card title={`API access (${keys.filter((k) => k.active && !k.revoked_at).length} active)`}>
          <p className="mb-3 text-sm text-slate-600">Each key acts as {u.name} with exactly the permissions above. Keys are shown once. Give each AI employee their own key so activity is attributed correctly. {!owner && "You can issue and revoke employees' keys; the Owner's and other Chiefs' keys are not visible to you."}</p>
          {keys.length > 0 && (
            <table className="mb-4 w-full text-sm"><thead className="border-b border-slate-200"><tr>{["Label", "Key", "Created", "Last used", "Status", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">{keys.map((k) => (
                <tr key={k.id}><td className="td">{k.label}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td text-slate-600">{fmtDateTime(k.created_at)}</td><td className="td text-slate-600">{k.last_used_at ? fmtDateTime(k.last_used_at) : "Never"}</td>
                  <td className="td">{k.revoked_at ? <Badge tone="red">Revoked</Badge> : k.active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Paused</Badge>}</td>
                  <td className="td"><div className="flex gap-1">{!k.revoked_at && (<>
                    <form action={keyToggleAction}><input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={k.id} /><input type="hidden" name="active" value={k.active ? "0" : "1"} /><button className="btn btn-sm">{k.active ? "Pause" : "Resume"}</button></form>
                    <form action={keyRevokeAction}><input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={k.id} /><button className="btn btn-sm btn-danger">Revoke</button></form></>)}</div></td></tr>))}</tbody></table>
          )}
          <SecretAction action={createKeyAction} submit="Create API key" className="flex flex-wrap items-end gap-2" secretLabel="Store it in the agent's secret settings now.">
            <input type="hidden" name="user_id" value={u.id} />
            <Field label="Label"><input name="label" className="input" placeholder="e.g. Sara agent — production" /></Field>
          </SecretAction>
        </Card>
      )}
    </div>
  );
}
