import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser, can } from "@/lib/auth";
import { listLeads, leadListExtras, leadStageCounts, leadFiltersFrom, type LeadFilters } from "@/lib/service/leads";
import { listCampaigns } from "@/lib/service/campaigns";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import { PageHeader, Flash, StageBadge, DemoBadge, Empty, Badge } from "@/components/ui";
import { Icon } from "@/components/dashboard/charts";
import { fmtDate, fmtShort, fmtYmd, isOverdue, toLocalInput } from "@/lib/format";
import { ACTIVITY_TYPE_LABEL, MESSAGE_KIND_LABEL } from "@/lib/constants";
import { demoOn, q, sget, snum, type SP } from "@/lib/view";
import { todayYmd } from "@/lib/db";

const OUTREACH_LABEL = { not_contacted: "Not contacted yet", no_reply: "Contacted, no reply", replied: "Replied", bounced: "Has a bounce", opted_out: "Opted out" } as const;
const TASK_LABEL = { open: "Has an open task", overdue: "Has an overdue task", none: "No open task" } as const;
const ACTIVE_LABEL = { "7": "Active in the last 7 days", "30": "Active in the last 30 days", "90": "Active in the last 90 days", stale30: "Quiet for 30+ days", stale90: "Quiet for 90+ days" } as const;
const CONTACT_LABEL = { has_email: "Has an email address", no_email: "No email address" } as const;
const ATTENTION_LABEL = { unanswered: "Reply not answered yet", quiet: "Nothing planned, quiet 7+ days" } as const;
const SORT_LABEL = { "": "Latest activity first", oldest: "Longest quiet first", added: "Newest leads first", due: "Next due first", company: "Company A–Z" } as const;
const STATE_TONE = { overdue: "red", blocked: "amber", ready: "green", planned: "gray", completed: "blue" } as const;

const ago = (iso?: string | null) => {
  if (!iso) return null;
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 60 ? `${Math.max(1, Math.floor(m))}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar date in plain words: today, yesterday, 5 days ago, 3 weeks ago, 4 months ago. */
const addedAgo = (ymd: string, today = todayYmd()) => {
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86400000);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 730) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
};

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const hideHist = sget(sp, "hide_hist") === "1";
  const size = [25, 50, 100, 200].includes(snum(sp, "size") ?? 0) ? (snum(sp, "size") as number) : 50;
  const f: LeadFilters = { ...leadFiltersFrom((k) => sget(sp, k)), page: snum(sp, "page") ?? 1, pageSize: size, includeDemo: await demoOn(), includeHistorical: !hideHist };
  const viewAll = can(me, "leads.view_all");
  const [res, stageCounts, lists, users, camps] = await Promise.all([listLeads(me, f), leadStageCounts(me, f), getLists(true), assignableUsers(), listCampaigns()]);
  const extra = await leadListExtras(res.rows.map((l) => l.id as number));
  const label = (kind: string) => Object.fromEntries(lists[kind].map((i) => [i.key, i.label])) as Record<string, string>;
  const L = { stage: label("stage"), market: label("market"), segment: label("segment"), industry: label("industry"), source: label("source"), service: label("service"), language: label("language"), channel: label("channel") };
  const flag = Object.fromEntries(lists.stage.map((i) => [i.key, i.flag]));
  const pages = Math.max(1, Math.ceil(res.total / size));

  // Everything that is in the URL, so links keep the other filters when they change one.
  const keep: Record<string, string | number | undefined> = {
    q: f.q, owner: f.owner, campaign: f.campaign, channel: f.channel, market: f.market, country: f.country, segment: f.segment, industry: f.industry, source: f.source, service: f.service, language: f.language,
    contact: f.contact, stage: f.stage, outreach: f.outreach, task: f.task, attention: f.attention, added_from: f.addedFrom, added_to: f.addedTo, active: f.active, sort: f.sort, hide_hist: hideHist ? 1 : undefined, size: size === 50 ? undefined : size,
  };
  const href = (change: Record<string, string | number | undefined>) => `/leads${q({ ...keep, ...change, page: undefined })}`;

  // What is switched on, in words, each with a link that switches only that one off.
  const userName = (id: number | "none" | undefined) => (id === "none" ? "nobody" : users.find((u) => u.id === id)?.name ?? `#${id}`);
  const active: { key: string; text: string; off: Record<string, undefined> }[] = [];
  const chip = (on: unknown, key: string, text: string, off: string[] = [key]) => { if (on) active.push({ key, text, off: Object.fromEntries(off.map((k) => [k, undefined])) }); };
  chip(f.q, "q", `Search: “${f.q}”`);
  chip(f.stage, "stage", `Stage: ${L.stage[f.stage ?? ""] ?? f.stage}`);
  chip(f.owner, "owner", `Owner: ${userName(f.owner)}`);
  chip(f.campaign, "campaign", f.campaign === "none" ? "In no campaign" : `Campaign: ${camps.find((c) => c.id === f.campaign)?.name ?? `#${f.campaign}`}`);
  chip(f.outreach, "outreach", f.outreach ? OUTREACH_LABEL[f.outreach] : "");
  chip(f.task, "task", f.task ? TASK_LABEL[f.task] : "");
  chip(f.attention, "attention", f.attention ? ATTENTION_LABEL[f.attention] : "");
  chip(f.market, "market", `Market: ${L.market[f.market ?? ""] ?? f.market}`);
  chip(f.country, "country", `Country: ${f.country}`);
  chip(f.segment, "segment", `Segment: ${L.segment[f.segment ?? ""] ?? f.segment}`);
  chip(f.industry, "industry", `Industry: ${L.industry[f.industry ?? ""] ?? f.industry}`);
  chip(f.source, "source", `Source: ${L.source[f.source ?? ""] ?? f.source}`);
  chip(f.service, "service", `Service: ${L.service[f.service ?? ""] ?? f.service}`);
  chip(f.language, "language", `Language: ${L.language[f.language ?? ""] ?? f.language}`);
  chip(f.channel, "channel", `Channel used: ${L.channel[f.channel ?? ""] ?? f.channel}`);
  chip(f.contact, "contact", f.contact ? CONTACT_LABEL[f.contact] : "");
  chip(f.active, "active", f.active ? ACTIVE_LABEL[f.active] : "");
  chip(f.addedFrom || f.addedTo, "added", `Added ${f.addedFrom ? `from ${fmtYmd(f.addedFrom)}` : ""}${f.addedFrom && f.addedTo ? " " : ""}${f.addedTo ? `to ${fmtYmd(f.addedTo)}` : ""}`, ["added_from", "added_to"]);
  chip(hideHist, "hide_hist", "Historical-only hidden");
  const moreOn = active.filter((a) => !["q", "stage"].includes(a.key)).length;

  // One-click views. Each replaces the filters with one clear question.
  const views: { label: string; params: Record<string, string>; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { label: "Needs a reply", params: { attention: "unanswered" }, icon: "reply" },
    { label: "Nothing planned", params: { attention: "quiet" }, icon: "moon" },
    { label: "Not contacted yet", params: { outreach: "not_contacted" }, icon: "mail" },
    { label: "Waiting for a reply", params: { outreach: "no_reply" }, icon: "clock" },
    { label: "Replied", params: { outreach: "replied" }, icon: "check" },
    { label: "Overdue task", params: { task: "overdue" }, icon: "alert" },
    ...(viewAll ? [{ label: "No campaign", params: { campaign: "none" }, icon: "block" as const }, { label: "No owner", params: { owner: "none" }, icon: "userPlus" as const }] : []),
  ];
  const viewOn = (p: Record<string, string>) => Object.entries(p).every(([k, v]) => String(keep[k] ?? "") === v) && active.filter((a) => a.key !== "hide_hist").length === 1;

  const Sel = ({ name, label: lb, value, children }: { name: string; label: string; value?: string | number; children: ReactNode }) => (
    <div><label className="label" htmlFor={`f-${name}`}>{lb}</label><select id={`f-${name}`} name={name} defaultValue={value ?? ""} className={`input ${value ? "border-brand-500! bg-brand-50!" : ""}`}>{children}</select></div>
  );
  const opts = (kind: keyof typeof L, withRetired = false) => lists[kind].filter((i) => withRetired || i.active).map((i) => <option key={i.key} value={i.key}>{i.label}{i.active ? "" : " (retired)"}</option>);
  const dict = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => <option key={k} value={k}>{v}</option>);
  const Group = ({ title, children }: { title: string; children: ReactNode }) => (
    <fieldset className="min-w-0"><legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</legend><div className="space-y-2.5">{children}</div></fieldset>
  );
  const totalAllStages = [...stageCounts.values()].reduce((a, n) => a + n, 0);
  const th = "th whitespace-nowrap";

  return (
    <div>
      <PageHeader title="Leads" sub={`${res.total} lead${res.total === 1 ? "" : "s"}${active.length ? " match your filters" : ""}${viewAll ? "" : " · assigned to you"}`}>
        {can(me, "leads.export") && <Link href={`/export/leads${q(keep)}`} className="btn">Export CSV</Link>}
        {can(me, "leads.import") && <Link href="/leads/import" className="btn">Import CSV</Link>}
        {can(me, "leads.create") && <Link href="/leads/new" className="btn btn-primary">+ New lead</Link>}
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      <form className="card mb-3">
        {f.stage && <input type="hidden" name="stage" value={f.stage} />}
        {/* 1. search and order */}
        <div className="flex flex-wrap items-end gap-2.5 p-3.5">
          <div className="min-w-64 flex-1"><label className="label" htmlFor="f-q">Search</label><input id="f-q" name="q" defaultValue={f.q} placeholder="Company, website, country, contact name or email…" className="input py-2" /></div>
          <div className="w-52"><Sel name="sort" label="Order" value={f.sort}>{dict(SORT_LABEL)}</Sel></div>
          <div className="w-24"><Sel name="size" label="Per page" value={size === 50 ? undefined : size}><option value="">50</option><option value="25">25</option><option value="100">100</option><option value="200">200</option></Sel></div>
          <button className="btn btn-primary py-2">Apply filters</button>
          <Link href="/leads" className="btn py-2">Reset</Link>
        </div>
        {/* 2. one-click views */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3.5 py-2.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quick views</span>
          <Link href="/leads" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium no-underline hover:no-underline ${active.length === 0 ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>All leads</Link>
          {views.map((v) => (
            <Link key={v.label} href={`/leads${q(v.params)}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium no-underline hover:no-underline ${viewOn(v.params) ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}><Icon name={v.icon} className="h-3.5 w-3.5" />{v.label}</Link>
          ))}
        </div>
        {/* 3. every filter, grouped by what it is about */}
        <details className="border-t border-slate-100" open={moreOn > 0}>
          <summary className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-slate-700">All filters{moreOn > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{moreOn} on</span>}</summary>
          <div className="grid gap-x-5 gap-y-5 px-3.5 pb-4 pt-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Group title="People and campaign">
              {viewAll && <Sel name="owner" label="Owner" value={f.owner}><option value="">Anyone</option><option value="none">No owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel>}
              <Sel name="campaign" label="Campaign" value={f.campaign}><option value="">Any</option><option value="none">In no campaign</option>{camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
              <Sel name="channel" label="Channel used" value={f.channel}><option value="">Any</option>{opts("channel")}</Sel>
            </Group>
            <Group title="Company">
              <Sel name="market" label="Target market" value={f.market}><option value="">Any</option>{opts("market")}</Sel>
              <div><label className="label" htmlFor="f-country">Country</label><input id="f-country" name="country" defaultValue={f.country} placeholder="e.g. UAE" className={`input ${f.country ? "border-brand-500! bg-brand-50!" : ""}`} /></div>
              <Sel name="industry" label="Industry" value={f.industry}><option value="">Any</option>{opts("industry")}</Sel>
              <Sel name="segment" label="Customer segment" value={f.segment}><option value="">Any</option>{opts("segment")}</Sel>
            </Group>
            <Group title="Lead profile">
              <Sel name="source" label="Lead source" value={f.source}><option value="">Any</option>{opts("source")}</Sel>
              <Sel name="service" label="Service of interest" value={f.service}><option value="">Any</option>{opts("service")}</Sel>
              <Sel name="language" label="Language" value={f.language}><option value="">Any</option>{opts("language")}</Sel>
              <Sel name="contact" label="Contact email" value={f.contact}><option value="">Any</option>{dict(CONTACT_LABEL)}</Sel>
            </Group>
            <Group title="Where it stands">
              <Sel name="outreach" label="Outreach" value={f.outreach}><option value="">Any</option>{dict(OUTREACH_LABEL)}</Sel>
              <Sel name="task" label="Open work" value={f.task}><option value="">Any</option>{dict(TASK_LABEL)}</Sel>
              <Sel name="attention" label="Needs attention" value={f.attention}><option value="">Any</option>{dict(ATTENTION_LABEL)}</Sel>
            </Group>
            <Group title="Dates">
              <Sel name="active" label="Last activity" value={f.active}><option value="">Any time</option>{dict(ACTIVE_LABEL)}</Sel>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label" htmlFor="f-af">Added from</label><input id="f-af" type="date" name="added_from" defaultValue={f.addedFrom} className={`input ${f.addedFrom ? "border-brand-500! bg-brand-50!" : ""}`} /></div>
                <div><label className="label" htmlFor="f-at">Added to</label><input id="f-at" type="date" name="added_to" defaultValue={f.addedTo} className={`input ${f.addedTo ? "border-brand-500! bg-brand-50!" : ""}`} /></div>
              </div>
              <label className="flex items-center gap-2 pt-1 text-[13px] text-slate-700" title="Companies kept only for past replies, bounces and opt-outs. Never outreach prospects."><input type="checkbox" name="hide_hist" value="1" defaultChecked={hideHist} /> Hide historical-only companies</label>
            </Group>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-3.5 py-2.5"><Link href="/leads" className="btn btn-sm">Clear all</Link><button className="btn btn-primary btn-sm">Apply filters</button></div>
        </details>
      </form>

      {/* stage strip: counts under the current filters; click to switch stage */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Link href={href({ stage: undefined })} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium no-underline hover:no-underline ${!f.stage ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>All stages <b className="tabular-nums">{totalAllStages}</b></Link>
        {lists.stage.filter((s) => s.active || stageCounts.get(s.key)).map((s) => {
          const n = stageCounts.get(s.key) ?? 0, on = f.stage === s.key;
          return <Link key={s.key} href={href({ stage: on ? undefined : s.key })} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium no-underline hover:no-underline ${on ? "border-brand-600 bg-brand-600 text-white" : n ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50" : "border-slate-200/70 bg-white/60 text-slate-400"}`}>{s.label} <b className="tabular-nums">{n}</b></Link>;
        })}
      </div>

      {active.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">Filtered by</span>
          {active.map((a) => <Link key={a.key} href={href(a.off)} title="Remove this filter" className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 font-medium text-brand-900 no-underline hover:bg-brand-100 hover:no-underline">{a.text}<span className="text-brand-600">×</span></Link>)}
          <Link href="/leads" className="ml-1">Clear all</Link>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1160px] text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-50"><tr>
            {["Date added", "Company", "Contact", "Campaign · owner", "Stage", "Outreach", "Last activity", "Next step", "Source"].map((h) => <th key={h} className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {res.rows.map((l) => {
              const c = extra.contact.get(l.id), o = extra.outreach.get(l.id), t = extra.nextTask.get(l.id), cs = extra.campaigns.get(l.id);
              const mk = l.market ? L.market[l.market] ?? l.market : null;
              const where = [l.country, mk && String(mk).toLowerCase() !== String(l.country ?? "").toLowerCase() ? mk : null].filter(Boolean).join(" · ");
              const kind = [l.industry ? L.industry[l.industry] ?? l.industry : null, l.segment ? L.segment[l.segment] ?? l.segment : null, l.service ? L.service[l.service] ?? l.service : null].filter(Boolean).join(" · ");
              // The lead date when it is known, otherwise the day it entered the CRM; shown in the app timezone.
              const addedIso = (l.lead_date ?? l.created_at) as string | null;
              const added = addedIso ? (/^\d{4}-\d{2}-\d{2}$/.test(addedIso) ? addedIso : toLocalInput(addedIso).slice(0, 10)) : "";
              return (
                <tr key={l.id} className="hover:bg-slate-50/70">
                  <td className="td whitespace-nowrap">
                    {added ? (
                      <div className="flex items-center gap-2.5" title={`${l.lead_date ? "Lead date" : "Entered in the CRM"}: ${fmtYmd(added)}`}>
                        <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 leading-none text-brand-900">
                          <span className="text-base font-semibold tabular-nums">{Number(added.slice(8, 10))}</span>
                          <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide">{MONTHS[Number(added.slice(5, 7)) - 1]}</span>
                        </div>
                        <div>
                          <div className="font-medium text-slate-800">{addedAgo(added)}</div>
                          <div className="text-xs text-slate-500">{added.slice(0, 4)}</div>
                        </div>
                      </div>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="td max-w-52">
                    <Link href={`/leads/${l.id}`} className="font-semibold">{l.company}</Link> {l.is_demo ? <DemoBadge /> : null}{l.historical_only ? <> <Badge tone="gray">historical</Badge></> : null}
                    <div className="truncate text-xs text-slate-500">{l.website ? <a href={l.website} target="_blank" rel="noreferrer" className="text-slate-500">{l.domain ?? l.website}</a> : "no website"}{where ? ` · ${where}` : ""}</div>
                    {kind && <div className="truncate text-xs text-slate-400">{kind}</div>}
                  </td>
                  <td className="td max-w-44">
                    {c ? (
                      <>
                        <div className="truncate text-slate-800">{c.name}{c.role ? <span className="text-slate-500"> · {c.role}</span> : null}</div>
                        <div className="truncate text-xs text-slate-500">{c.email ?? "no email"}</div>
                        <div className="flex flex-wrap gap-1 pt-0.5">{c.optedOut && <Badge tone="amber">opted out</Badge>}{c.bounced && <Badge tone="red">bounced</Badge>}{c.count > 1 && <span className="text-xs text-slate-400">+{c.count - 1} more</span>}</div>
                      </>
                    ) : <span className="text-amber-700">no contact</span>}
                  </td>
                  <td className="td">
                    {cs?.length ? cs.map((x) => <div key={x.id}><Link href={href({ campaign: x.id })} className="text-slate-800">{x.name}</Link></div>) : l.historical_only ? <span className="text-slate-400">—</span> : <span className="text-amber-700">no campaign</span>}
                    <div className="text-xs text-slate-500">{l.owner_name ?? <span className="text-amber-700">no owner</span>}</div>
                  </td>
                  <td className="td"><StageBadge stage={l.stage} label={L.stage[l.stage] ?? l.stage} flag={flag[l.stage]} /></td>
                  <td className="td whitespace-nowrap">
                    {!o || (o.sent === 0 && o.replies === 0) ? <span className="text-slate-400">not contacted</span> : (
                      <>
                        <div className="flex items-center gap-1.5"><span className="font-semibold text-slate-900 tabular-nums">{o.sent}</span><span className="text-slate-500">sent</span>{o.replies > 0 && <Badge tone="green">{o.replies} {o.replies === 1 ? "reply" : "replies"}</Badge>}{o.bounced && <Badge tone="red">bounce</Badge>}</div>
                        <div className="text-xs text-slate-500">{o.lastReplyAt ? `replied ${ago(o.lastReplyAt)}` : o.lastSentAt ? `last sent ${ago(o.lastSentAt)}` : ""}</div>
                      </>
                    )}
                  </td>
                  <td className="td whitespace-nowrap">
                    {o?.lastType ? <div className="text-slate-800">{o.lastType === "message" ? MESSAGE_KIND_LABEL[o.lastKind ?? ""] ?? "Message" : ACTIVITY_TYPE_LABEL[o.lastType] ?? o.lastType}</div> : <div className="text-slate-400">nothing yet</div>}
                    <div className="text-xs text-slate-500" title={fmtShort(l.last_activity_at)}>{ago(l.last_activity_at) ?? "—"}</div>
                  </td>
                  <td className="td max-w-52">
                    {t ? (
                      <>
                        <div className="flex items-center gap-2"><Link href={`/tasks/${t.id}`} className="truncate font-medium">{t.title}</Link><Badge tone={STATE_TONE[t.state as keyof typeof STATE_TONE]}>{t.state}</Badge></div>
                        <div className="truncate text-xs text-slate-500" title={t.reason ?? undefined}>{t.assignee_name}{t.date_only ? ` · ${fmtYmd(t.on)}` : t.sort_at ? ` · ${fmtShort(t.sort_at)}` : " · no date"}{t.reason ? ` · ${t.reason}` : ""}</div>
                      </>
                    ) : l.next_action ? (
                      // No open task: fall back to the old free-text note, clearly marked as such.
                      <><div className="truncate text-slate-600">{l.next_action}</div><div className={`text-xs ${isOverdue(l.next_due_at) ? "text-red-600" : "text-slate-400"}`}>old note, no task{l.next_due_at ? ` · ${fmtDate(l.next_due_at)}` : ""}</div></>
                    ) : <span className="text-slate-400">nothing planned</span>}
                  </td>
                  <td className="td whitespace-nowrap">
                    {l.source ? <span className="text-slate-700">{L.source[l.source] ?? l.source}</span> : <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {res.rows.length === 0 && <div className="text-center [&_p]:text-center!"><Empty>No leads match these filters. {active.length > 0 ? <Link href="/leads">Clear the filters</Link> : can(me, "leads.create") && <Link href="/leads/new">Add the first one</Link>}</Empty></div>}
      </div>
      {res.total > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-500">{(res.page - 1) * size + 1}–{Math.min(res.page * size, res.total)} of {res.total}{pages > 1 ? ` · page ${res.page} of ${pages}` : ""}</span>
          <div className="flex gap-2">
            {res.page > 1 && <Link className="btn btn-sm" href={`/leads${q({ ...keep, page: res.page - 1 })}`}>← Previous</Link>}
            {res.page < pages && <Link className="btn btn-sm" href={`/leads${q({ ...keep, page: res.page + 1 })}`}>Next →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
