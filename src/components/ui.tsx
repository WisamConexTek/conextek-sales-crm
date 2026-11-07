import Link from "next/link";
import type { ReactNode } from "react";
import { TASK_STATUS_LABEL, OUTCOME_LABEL, EMAIL_STATUS_LABEL } from "@/lib/constants";

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-slate-500">{sub}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: "red" | "amber" | "green" }) {
  const color = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-emerald-600" : "text-slate-900";
  const body = (
    <div className="card h-full p-4 transition hover:border-slate-300">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block no-underline">{body}</Link> : body;
}

const TONES: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700", blue: "bg-blue-100 text-blue-800", green: "bg-emerald-100 text-emerald-800",
  red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-800", purple: "bg-violet-100 text-violet-800", sky: "bg-sky-100 text-sky-800",
};
export function Badge({ tone = "gray", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function StageBadge({ stage, label, flag }: { stage: string; label?: string; flag?: string | null }) {
  const tone = flag === "won" ? "green" : flag === "lost" ? "red" : flag === "closed" ? "gray" : flag === "meeting" ? "purple" : flag === "replied" ? "sky" : "blue";
  return <Badge tone={tone}>{label ?? stage}</Badge>;
}

export function StatusBadge({ status, approvalFrom }: { status: string; approvalFrom?: string | null }) {
  const tone: Record<string, string> = { todo: "gray", in_progress: "blue", waiting_approval: "amber", changes_requested: "red", approved: "green", completed: "green", cancelled: "gray" };
  const label = TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL] ?? status;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={tone[status] as never}>{label}</Badge>
      {status === "waiting_approval" && approvalFrom && <Badge tone="purple">on {approvalFrom === "wisam" ? "Wisam" : "Chief"}</Badge>}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: string | null }) {
  if (!outcome) return null;
  const tone: Record<string, string> = { sent: "blue", reply_received: "green", bounced: "red", no_response_yet: "gray", opted_out: "amber" };
  return <Badge tone={tone[outcome] as never}>{OUTCOME_LABEL[outcome as keyof typeof OUTCOME_LABEL] ?? outcome}</Badge>;
}
export function EmailStatusBadge({ s }: { s: string }) {
  const tone: Record<string, string> = { unknown: "gray", ok: "green", bounced: "red", opted_out: "amber" };
  return <Badge tone={tone[s] as never}>{EMAIL_STATUS_LABEL[s] ?? s}</Badge>;
}
export const DemoBadge = () => <Badge tone="amber">DEMO</Badge>;

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (!ok && !err) return null;
  return (
    <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${err ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`} role="status">
      {err || ok}
    </div>
  );
}

export function Field({ label, children, hint, className = "" }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Opts({ items, empty }: { items: { key: string; label: string }[]; empty?: string }) {
  return (
    <>
      {empty !== undefined && <option value="">{empty}</option>}
      {items.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function Hidden({ back, ...rest }: { back: string } & Record<string, string | number>) {
  return (
    <>
      <input type="hidden" name="_back" value={back} />
      {Object.entries(rest).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
    </>
  );
}

export function LeadLink({ id, company }: { id?: number | null; company?: string | null }) {
  return id ? <Link href={`/leads/${id}`} className="font-medium">{company ?? `Lead #${id}`}</Link> : <span className="text-slate-400">—</span>;
}
