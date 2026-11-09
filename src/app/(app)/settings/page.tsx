import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, isManager } from "@/lib/auth";
import { listUsers, listKeys, canManageKeysFor } from "@/lib/service/users";
import { getLists } from "@/lib/service/lists";
import { all, one } from "@/lib/db";
import { demoCount } from "@/lib/service/demo";
import { listSenders, senderLog, sendersHealth } from "@/lib/service/senders";
import { createSenderAction, updateSenderAction, setWarmupAction, pauseSenderAction, resumeSenderAction, loadDemoAction, removeDemoAction, createUserAction, addListItemAction, updateListItemAction, moveListItemAction } from "@/app/actions";
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
  const tab = sget(sp, "tab") === "lists" && owner ? "lists" : sget(sp, "tab") === "senders" && owner ? "senders" : sget(sp, "tab") === "history" ? "history" : "team";
  const tabs: [string, string][] = [["team", "Team & permissions"], ...(owner ? [["lists", "Lists & stages"] as [string, string], ["senders", "Senders & warm-up"] as [string, string]] : []), ["history", "Change history"]];

  return (
    <div className="space-y-5">
      <PageHeader title="Settings & Permissions" sub={owner ? "Full owner access" : "Chief: you can add employees, adjust their permissions, reset passwords and issue or revoke employee API keys"} />
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(([k, l]) => <Link key={k} href={`/settings?tab=${k}`} className={`-mb-px border-b-2 px-4 py-2 text-sm no-underline hover:no-underline ${tab === k ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-slate-600"}`}>{l}</Link>)}
      </div>
      {tab === "team" && <Team owner={owner} me={me} />}
      {tab === "lists" && owner && <Lists />}
      {tab === "senders" && owner && <Senders />}
      {tab === "history" && <History page={snum(sp, "page") ?? 1} action={sget(sp, "action")} />}
    </div>
  );
}

async function Team({ owner, me }: { owner: boolean; me: Awaited<ReturnType<typeof requireUser>> }) {
  const [users, keys] = await Promise.all([listUsers(), listKeys(undefined, me)]);
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
                    <td className="td">{canManageKeysFor(me, u) ? k : "—"}</td>
                    <td className="td text-slate-600">{u.last_login_at ? fmtDateTime(u.last_login_at) : "Never"}</td>
                    <td className="td">{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Disabled</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {(
        <Card title={owner ? "Add a team member" : "Add an employee"}>
          <SecretAction action={createUserAction} submit="Create account" className="grid max-w-4xl gap-3 md:grid-cols-5" secretLabel="Share it securely. They can change it any time under Account.">
            <Field label="Name"><input name="name" className="input" required /></Field>
            <Field label="Username"><input name="username" className="input" required pattern="[a-zA-Z0-9._\-]+" minLength={3} /></Field>
            <Field label="Role"><select name="role" className="input"><option value="employee">Employee</option>{owner && <option value="chief">Chief</option>}</select></Field>
            <Field label="Password (min 10 chars, blank = generate)"><input name="password" type="text" autoComplete="off" minLength={10} className="input" /></Field>
            <Field label="Permission preset"><select name="preset" className="input" defaultValue="researcher">{Object.entries(PRESETS).filter(([k, p]) => k !== "owner" && (owner || p.role === "employee")).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select></Field>
          </SecretAction>
          <p className="mt-3 text-xs text-slate-500">After creating the account, open it to fine-tune permissions and issue the employee's API key{owner ? "" : " (you can do this yourself — no need to ask the Owner)"}. New people can be added any time — nothing else needs to change.</p>
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
      <Card title="Test data">
        <p className="mb-3 text-sm text-slate-600">Production starts empty. Anything marked <b>TEST</b> (demo samples, or real leads you flagged during testing) stays visible and labelled, but is never counted in the dashboard or reports. Owner or Chief can mark or unmark a lead on its page; the whole lead history, tasks and approvals follow it. Removing test data deletes it permanently.</p>
        <p className="mb-3 text-sm text-slate-700"><b>{await demoCount()}</b> lead(s) currently marked as test data.</p>
        <div className="flex flex-wrap items-end gap-2">
          <form action={loadDemoAction}><input type="hidden" name="_back" value="/settings?tab=lists" /><button className="btn">Load sample demo data</button></form>
          {(await demoCount()) > 0 && (
            <form action={removeDemoAction} className="flex items-end gap-2"><input type="hidden" name="_back" value="/settings?tab=lists" />
              <input name="confirm" className="input w-36" placeholder="Type DELETE" autoComplete="off" />
              <button className="btn btn-danger">Remove all test data</button></form>
          )}
        </div>
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

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "gray"> = { active: "green", warming_up: "amber", paused: "red", inactive: "gray" };
const STATUS_LABEL: Record<string, string> = { active: "Active", warming_up: "Warming up", paused: "Paused", inactive: "Off" };
const LANG_LABEL: Record<string, string> = { en: "English", ar: "Arabic", zh: "Chinese" };

async function Senders() {
  const [senders, camps, log, health] = await Promise.all([listSenders(), all("SELECT id,name FROM campaigns ORDER BY id"), senderLog({} as never), sendersHealth()]);
  const hmap = new Map(health.map((h) => [h.sender_id, h]));
  const back = "/settings?tab=senders";
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">A sender is the mailbox a message is sent <b>from</b> by your browser workflow. The CRM never sends. Each sender has its own daily cap (or a warm-up schedule), languages, and campaigns. A version, a send and its capacity are always charged to one sender. Times are Asia/Hebron.</p>
      {senders.map((x) => {
        const h = hmap.get(x.id)!;
        return (
          <Card key={x.id} title={`${x.display_name} <${x.email}>`} right={<Badge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status]}</Badge>}>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
              <span>Today: <b>{h.used_today}</b> of <b>{h.daily_cap === null ? "no cap" : h.daily_cap}</b>{h.warmup_not_started ? " (warm-up not started)" : ""}</span>
              <span>7 days: <b>{h.sent_7d}</b> sent · <b>{h.bounces_7d}</b> bounces{h.bounce_rate_7d !== null ? ` (${(h.bounce_rate_7d * 100).toFixed(1)}%)` : ""} · <b>{h.replies_7d}</b> replies · <b>{h.complaints_7d}</b> complaints</span>
            </div>
            {x.paused_at && (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <b>Paused {x.pause_kind === "auto" ? "automatically (deliverability guard)" : "by the Owner"}</b> on {fmtDateTime(x.paused_at)}: {x.pause_reason}. Cold sends from this mailbox are blocked until you resume it.
                <form action={resumeSenderAction} className="mt-2 flex gap-2"><input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={x.id} />
                  <input name="reason" className="input" placeholder="Why is it safe to resume? (required)" required minLength={3} /><button className="btn btn-primary">Resume</button></form>
              </div>
            )}
            <form action={updateSenderAction} className="grid gap-3 md:grid-cols-6">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={x.id} />
              <Field label="Email"><input name="email" defaultValue={x.email} className="input" required /></Field>
              <Field label="Display name"><input name="display_name" defaultValue={x.display_name} className="input" required /></Field>
              <Field label="Title"><input name="title" defaultValue={x.title ?? ""} className="input" /></Field>
              <Field label="Daily cap (blank = no cap; ignored while a warm-up schedule exists)"><input name="daily_cap" type="number" min={0} defaultValue={x.daily_cap ?? ""} className="input" /></Field>
              <Field label="Status"><select name="active" defaultValue={x.active ? "1" : "0"} className="input"><option value="1">On</option><option value="0">Off</option></select></Field>
              <div />
              <div className="md:col-span-2"><span className="label">Languages allowed</span>
                <div className="flex gap-3 pt-1 text-sm">{Object.entries(LANG_LABEL).map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="languages" value={k} defaultChecked={x.languages.includes(k)} />{l}</label>)}</div></div>
              <div className="md:col-span-3"><span className="label">Campaigns / markets allowed</span>
                <div className="flex flex-wrap gap-3 pt-1 text-sm">
                  <label className="flex items-center gap-1"><input type="checkbox" name="all_campaigns" value="1" defaultChecked={x.campaign_ids === null} />All campaigns</label>
                  {camps.map((c) => <label key={c.id as number} className="flex items-center gap-1"><input type="checkbox" name="campaign_ids" value={c.id as number} defaultChecked={x.campaign_ids?.includes(c.id as number)} />{c.name}</label>)}
                </div></div>
              <div className="flex items-end"><button className="btn btn-primary">Save sender</button></div>
            </form>
            <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 md:grid-cols-2">
              <form action={setWarmupAction}>
                <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={x.id} />
                <label className="label">Warm-up schedule (one line per step: date from which it applies, then messages per day)</label>
                <textarea name="steps" rows={6} className="input font-mono text-xs" defaultValue={x.warmup.map((s) => `${s.from_date}: ${s.daily_cap}`).join("\n")} placeholder={"2026-11-10: 5\n2026-11-17: 8"} />
                <p className="mt-1 text-xs text-slate-500">The last step stays in force. Before the first date the cap is 0. Leave empty to switch warm-up off and use the daily cap above. Today&apos;s cap: <b>{x.cap_today.cap === null ? "none" : x.cap_today.cap}</b>.</p>
                <button className="btn btn-sm mt-2">Save warm-up</button>
              </form>
              {!x.paused_at && (
                <form action={pauseSenderAction}>
                  <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={x.id} />
                  <label className="label">Pause cold sends from this mailbox</label>
                  <input name="reason" className="input" placeholder="Reason (required, shown to everyone)" required minLength={3} />
                  <p className="mt-1 text-xs text-slate-500">It also pauses itself if its 7-day bounce rate goes above 3% or it gets any spam complaint. Only you can resume it.</p>
                  <button className="btn btn-sm mt-2">Pause sender</button>
                </form>
              )}
            </div>
          </Card>
        );
      })}
      <Card title="Add a sender">
        <form action={createSenderAction} className="grid gap-3 md:grid-cols-5">
          <input type="hidden" name="_back" value={back} />
          <Field label="Email"><input name="email" type="email" className="input" required /></Field>
          <Field label="Display name"><input name="display_name" className="input" required /></Field>
          <Field label="Title"><input name="title" className="input" /></Field>
          <Field label="Daily cap"><input name="daily_cap" type="number" min={0} defaultValue={0} className="input" /></Field>
          <div className="flex items-end"><button className="btn btn-primary">Add sender</button></div>
          <div className="md:col-span-5 flex flex-wrap gap-4 text-sm"><span className="label">Languages</span>
            {Object.entries(LANG_LABEL).map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="languages" value={k} defaultChecked={k === "en"} />{l}</label>)}
            <span className="label">Campaigns</span><label className="flex items-center gap-1"><input type="checkbox" name="all_campaigns" value="1" defaultChecked />All</label>
            {camps.map((c) => <label key={c.id as number} className="flex items-center gap-1"><input type="checkbox" name="campaign_ids" value={c.id as number} />{c.name}</label>)}</div>
        </form>
      </Card>
      <Card title="Sender history (who paused, resumed or changed, and why)">
        {log.length === 0 ? <p className="text-sm text-slate-500">Nothing yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {log.map((e) => (
              <li key={e.id as number} className="py-1.5"><span className="text-slate-500">{fmtDateTime(e.created_at as string)}</span> · <b>{e.email as string}</b> · {String(e.action).replace("_", " ")}{e.reason ? <> — {e.reason as string}</> : null} <span className="text-slate-500">by {e.actor_name as string}{e.auto ? " (automatic)" : ""}</span></li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
