import Link from "next/link";
import { requireUser, isManager } from "@/lib/auth";
import { listSequences, seqSettings, roleUsers, backfill, sequenceLog, MARKET_GROUPS } from "@/lib/service/sequences";
import { listSenders, bounceLimit } from "@/lib/service/senders";
import { assignableUsers } from "@/lib/service/users";
import { saveSequenceAction, saveSequenceSettingsAction, backfillAction, createSequenceAction } from "@/app/actions";
import { listCampaigns } from "@/lib/service/campaigns";
import { STEP_CODES, STEP_SHORT, WORK_ROLE_LABEL, type WorkRole } from "@/lib/constants";
import { Badge, Card, Empty, Flash, PageHeader } from "@/components/ui";
import { fmtDateTime, fmtYmd } from "@/lib/format";
import { sget, type SP } from "@/lib/view";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MARKET_LABEL: Record<string, string> = { china: "China", us: "United States", gulf: "Gulf" };
const ANCHOR: Record<string, string> = { first: "days after the first step", previous: "days after the step before", condition: "days after the invitation is accepted" };

/** Settings, Follow-up sequences: the steps of each sequence, the working days, who does what, and the backfill for leads contacted earlier. */
export default async function SequencesSettings({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  if (!isManager(me)) return <div className="space-y-5"><PageHeader title="Follow-up sequences" /><Card><Empty>Only the Owner and the Chief can open this page.</Empty></Card></div>;
  const owner = me.role === "owner";
  const [seqs, settings, senders, users, limit, dry, log, camps] = await Promise.all([listSequences(), seqSettings(), listSenders(), assignableUsers(), bounceLimit(), backfill(me, { dry_run: true }) as Promise<any>, sequenceLog(8), listCampaigns()]);
  const roles = await roleUsers(settings);
  const dis = owner ? {} : { disabled: true };
  return (
    <div className="space-y-5">
      <PageHeader title="Follow-up sequences" sub="A recorded send plans the next step by itself. Nothing here sends or approves a message.">
        <Link href="/settings" className="btn">All settings</Link>
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      {!owner && <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">You can read these settings and run the backfill. Only the Owner can change them.</p>}

      <Card title={`Leads contacted before sequences existed (${dry.total})`}>
        {dry.total === 0 ? <Empty>Every contacted lead that is still waiting for a reply is in a sequence.</Empty> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {[["Due or overdue now", dry.summary.due_or_overdue], ["of them late (window passed)", dry.summary.late_items], ["Not due yet", dry.summary.upcoming], ["Sequence already finished", dry.summary.sequence_finished_rest], ["In no campaign", dry.summary.in_no_campaign]].map(([l, n]) => (
                <div key={l as string} className="rounded-lg border border-slate-200 px-3 py-2.5"><div className="text-xs text-slate-500">{l}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{n as number}</div></div>
              ))}
            </div>
            <p className="mt-3 text-sm text-slate-600">{dry.rules}</p>
            <details className="mt-3">
              <summary className="text-[13px] font-medium text-slate-700">See the list ({dry.items.length})</summary>
              <div className="mt-2 max-h-96 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead className="sticky top-0 bg-slate-50"><tr>{["Company", "Campaign", "Sent so far", "Next step", "Due", "Window to", "What will happen"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {dry.items.map((i: any) => (
                      <tr key={`${i.lead_id}-${i.channel}`}>
                        <td className="td"><Link href={`/leads/${i.lead_id}`}>{i.company}</Link></td>
                        <td className="td">{i.campaign ?? <span className="text-amber-700">no campaign</span>}</td>
                        <td className="td">{i.sent.map((s: any) => STEP_SHORT[s.code] ?? s.code).join(", ")}</td>
                        <td className="td">{i.next ? STEP_SHORT[i.next.code] ?? i.next.code : "none"}</td>
                        <td className="td whitespace-nowrap">{i.next ? fmtYmd(i.next.due_on) : i.rest_until ? `rest to ${fmtYmd(i.rest_until)}` : ""}</td>
                        <td className="td whitespace-nowrap">{i.next ? fmtYmd(i.next.window_end_on) : ""}</td>
                        <td className="td">{i.action}{i.state === "late" ? <Badge tone="gray">LATE</Badge> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <form action={backfillAction} className="mt-3 flex flex-wrap items-center gap-3">
              <input type="hidden" name="_back" value="/settings/sequences" />
              <button className="btn btn-primary">Plan the next step for these leads (40 at a time)</button>
              <span className="text-xs text-slate-500">Creates the tasks only. Each one still needs a draft and both approvals.</span>
            </form>
          </>
        )}
      </Card>

      {seqs.map((s: any) => (
        <Card key={s.id} title={<>{s.name} <span className="font-normal text-slate-500">· version {s.version}</span></>} right={<span className="text-slate-500">{Object.entries(s.enrolled).map(([k, n]) => `${n} ${k}`).join(" · ") || "no lead enrolled yet"}</span>}>
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-[13px] text-slate-800">{s.preview}</p>
          <form action={saveSequenceAction} className="mt-3 space-y-3">
            <input type="hidden" name="_back" value="/settings/sequences" /><input type="hidden" name="id" value={s.id} /><input type="hidden" name="step_count" value={s.steps.length + 1} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-slate-50"><tr>{["#", "Step", "Counted from", "Due on day", "Window ends on day", "At least N days after the step before", "Drafted by", "On"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {s.steps.map((st: any, i: number) => (
                    <tr key={st.id}>
                      <td className="td tabular-nums text-slate-500">{i + 1}</td>
                      <td className="td"><select name={`code_${i}`} defaultValue={st.step_code} className="input w-36" {...dis}>{STEP_CODES.map((c) => <option key={c} value={c}>{STEP_SHORT[c]}</option>)}</select></td>
                      <td className="td">{i === 0 ? <><input type="hidden" name={`anchor_${i}`} value={st.anchor} /><span className="text-slate-500">{st.anchor === "condition" ? "the accepted invitation" : "the start"}</span></> : <select name={`anchor_${i}`} defaultValue={st.anchor} className="input w-56" {...dis}>{Object.entries(ANCHOR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</td>
                      <td className="td"><input type="number" min={0} max={365} name={`start_${i}`} defaultValue={st.offset_start} className="input w-20" {...dis} /></td>
                      <td className="td"><input type="number" min={0} max={365} name={`end_${i}`} defaultValue={st.offset_end} className="input w-20" {...dis} /></td>
                      <td className="td"><input type="number" min={0} max={365} name={`gap_${i}`} defaultValue={st.min_gap_prev ?? ""} placeholder="none" className="input w-20" {...dis} /></td>
                      <td className="td"><select name={`role_${i}`} defaultValue={st.assignee_role} className="input w-40" {...dis}>{(["writer", "linkedin", "inbox", "hunter", "chief"] as WorkRole[]).map((r) => <option key={r} value={r}>{WORK_ROLE_LABEL[r]}</option>)}</select></td>
                      <td className="td"><input type="checkbox" name={`active_${i}`} defaultChecked={!!st.active} aria-label={`Step ${i + 1} active`} {...dis} /></td>
                    </tr>
                  ))}
                  {owner && (() => { const i = s.steps.length; return (
                    <tr className="bg-slate-50/60">
                      <td className="td text-slate-400">+</td>
                      <td className="td"><select name={`code_${i}`} defaultValue="" className="input w-36" aria-label="Add a step"><option value="">Add a step…</option>{STEP_CODES.map((c) => <option key={c} value={c}>{STEP_SHORT[c]}</option>)}</select></td>
                      <td className="td"><select name={`anchor_${i}`} defaultValue="previous" className="input w-56">{Object.entries(ANCHOR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                      <td className="td"><input type="number" min={0} max={365} name={`start_${i}`} defaultValue={7} className="input w-20" /></td>
                      <td className="td"><input type="number" min={0} max={365} name={`end_${i}`} defaultValue={10} className="input w-20" /></td>
                      <td className="td"><input type="number" min={0} max={365} name={`gap_${i}`} placeholder="none" className="input w-20" /></td>
                      <td className="td"><select name={`role_${i}`} defaultValue={s.channel === "linkedin" ? "linkedin" : "writer"} className="input w-40">{(["writer", "linkedin", "inbox", "hunter", "chief"] as WorkRole[]).map((r) => <option key={r} value={r}>{WORK_ROLE_LABEL[r]}</option>)}</select></td>
                      <td className="td"><input type="checkbox" name={`active_${i}`} defaultChecked aria-label="New step active" /></td>
                    </tr>
                  ); })()}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div><label className="label">Rest after the last step (days)</label><input type="number" min={0} max={730} name="rest_days" defaultValue={s.rest_days} className="input w-28" {...dis} /></div>
              <div><label className="label">Days are counted as</label><select name="day_mode" defaultValue={s.day_mode} className="input w-44" {...dis}><option value="calendar">Calendar days</option><option value="business">Working days</option></select></div>
              <div><label className="label">Status</label><select name="status" defaultValue={s.status} className="input w-32" {...dis}><option value="active">Active</option><option value="draft">Draft</option><option value="retired">Retired</option></select></div>
              <label className="flex items-center gap-2 pb-2 text-[13px] text-slate-700"><input type="checkbox" name="auto_enroll" defaultChecked={!!s.auto_enroll} {...dis} /> Enroll leads automatically when the first step is sent</label>
              <div className="min-w-56 flex-1"><label className="label">Why this change (kept in the history)</label><input name="reason" className="input" placeholder="Optional" {...dis} /></div>
              {owner && <button className="btn btn-primary">Save as a new version</button>}
            </div>
            <p className="text-xs text-slate-500">Weekend days for this market: {s.weekend_days.join(", ")}. A due day on a weekend moves to the next working day. Saving applies to leads enrolled from now on; leads already in the sequence keep their version.</p>
          </form>
        </Card>
      ))}

      {owner && (
        <Card title="New sequence">
          <form action={createSequenceAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="_back" value="/settings/sequences" />
            <div className="min-w-56 flex-1"><label className="label">Name</label><input name="name" required minLength={2} className="input" placeholder="e.g. Canton Fair, email, 4 steps" /></div>
            <div><label className="label">Campaign</label><select name="campaign_id" className="input w-48"><option value="">Any campaign</option>{camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className="label">Channel</label><select name="channel" className="input w-32"><option value="email">Email</option><option value="linkedin">LinkedIn</option></select></div>
            <div><label className="label">Start from the steps of</label><select name="copy_from" required className="input w-56">{seqs.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
            <button className="btn btn-primary">Create as a draft</button>
          </form>
          <p className="mt-2 text-xs text-slate-500">A new sequence is a draft: no lead follows it until you set its status to Active. Only one sequence can be active for the same campaign and channel, so retire the old one first. To add a fourth or fifth email, use the “Add a step” row at the bottom of any sequence and save; to drop a step, untick it.</p>
        </Card>
      )}

      <Card title="Working days, roles, capacity and deadlines">
        <form action={saveSequenceSettingsAction} className="space-y-5">
          <input type="hidden" name="_back" value="/settings/sequences" />
          <div className="grid gap-4 md:grid-cols-3">
            {MARKET_GROUPS.map((m) => (
              <fieldset key={m}><legend className="label">Weekend days · {MARKET_LABEL[m]}</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1">{DAYS.map((d, i) => <label key={d} className="inline-flex items-center gap-1 text-[13px]"><input type="checkbox" name={`weekend_${m}`} value={i} defaultChecked={settings.weekends[m].includes(i)} {...dis} /> {d}</label>)}</div>
              </fieldset>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(["writer", "hunter", "inbox", "linkedin", "chief", "compliance"] as WorkRole[]).map((r) => (
              <div key={r}><label className="label">{WORK_ROLE_LABEL[r]} is</label>
                <select name={`role_${r}`} defaultValue={settings.roles[r] ?? ""} className="input" {...dis}><option value="">Automatic{roles[r] ? ` (${users.find((u) => u.id === roles[r])?.name ?? "user " + roles[r]})` : " (nobody found)"}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {senders.map((x: any) => <div key={x.id}><label className="label">First-email minimum per day · {x.display_name}</label><input type="number" min={0} max={500} name={`floor_${x.id}`} defaultValue={x.first_email_floor ?? 0} className="input" {...dis} /></div>)}
            <div><label className="label">Late items per sender per day</label><input type="number" min={0} max={500} name="late_daily_limit" defaultValue={settings.late_daily_limit} className="input" {...dis} /></div>
            <div><label className="label">Lead buffer for the Lead Hunter (%)</label><input type="number" min={0} max={200} name="plan_buffer_pct" defaultValue={Math.round(settings.plan_buffer * 100)} className="input" {...dis} /></div>
            <div><label className="label">Pause a sender above this 7-day bounce rate (%)</label><input type="number" min={0.1} max={50} step={0.1} name="bounce_limit_pct" defaultValue={+(limit * 100).toFixed(2)} className="input" {...dis} /></div>
            <div><label className="label">Reply to be handled within (working hours)</label><input type="number" min={1} max={240} name="reply_sla_hours" defaultValue={settings.reply_sla_hours} className="input" {...dis} /></div>
            <div><label className="label">Drafting deadline, the day before</label><input type="time" name="draft_deadline_time" defaultValue={settings.draft_deadline_time} className="input" {...dis} /></div>
            {(["hunter", "writer", "chief", "owner"] as const).map((r) => <div key={r}><label className="label">Shortfall check · {WORK_ROLE_LABEL[r]}</label><input type="time" name={`cut_${r}`} defaultValue={settings.cutoffs[r]} className="input" {...dis} /></div>)}
          </div>
          <p className="text-xs text-slate-500">Each sender's daily slots go, in order, to: follow-ups inside their window, overdue follow-ups, the first-email minimum, late items, then the remaining first emails. All times are Asia/Hebron.</p>
          {owner && <button className="btn btn-primary">Save settings</button>}
        </form>
      </Card>

      <Card title="Recent changes">
        {log.length ? <ul className="space-y-1 text-[13px] text-slate-700">{log.map((l) => <li key={l.id as number}>{fmtDateTime(l.created_at as string)} · {l.actor_name as string} changed {l.entity === "sequence" ? `sequence #${l.entity_id}` : "the follow-up settings"}</li>)}</ul> : <Empty>No change yet.</Empty>}
      </Card>
    </div>
  );
}
