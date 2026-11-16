import Link from "next/link";
import type { ReactNode } from "react";

/* Dashboard building blocks. Server-rendered, no client script: hover and keyboard focus use plain CSS. */

/* ---------- icons (16px, drawn with the text colour) ---------- */
const ICONS = {
  mail: "M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 13.5v-7Zm.8.2 6.2 4.3 6.2-4.3",
  reply: "M8 5 3.5 9.5 8 14M4 9.5h7a5 5 0 0 1 5 5V15",
  rate: "M3 14.5 7.5 10l3 3L17 6.5M12.5 6.5H17V11",
  calendar: "M5 3.5v2.5M15 3.5v2.5M3.5 8.5h13M5 5h10a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5Z",
  userPlus: "M8 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 16.5a5.5 5.5 0 0 1 11 0M15 6v5M12.5 8.5h5",
  check: "M4 10.5 8 14.5 16 6",
  chevron: "M7.5 5 12.5 10 7.5 15",
  send: "M17 3 9 11M17 3l-5 14-3-6-6-3 14-5Z",
  clock: "M10 5.5V10l3 2M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  alert: "M10 7v4M10 14h.01M8.6 3.8 2.6 14a1.6 1.6 0 0 0 1.4 2.4h12a1.6 1.6 0 0 0 1.4-2.4l-6-10.2a1.6 1.6 0 0 0-2.8 0Z",
  block: "M5 5l10 10M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  moon: "M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5Z",
  bot: "M10 3v2.5M6 5.5h8A2.5 2.5 0 0 1 16.5 8v5a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 13V8A2.5 2.5 0 0 1 6 5.5ZM7.5 10v1M12.5 10v1",
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true"><path d={ICONS[name]} /></svg>;
}

/* ---------- layout ---------- */

/** One band of the page: a heading that says what the cards under it have in common. */
export function Band({ title, sub, live, right, children }: { title: string; sub?: ReactNode; live?: boolean; right?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2.5">
          <span className="h-4 w-1 rounded-full bg-brand-600" aria-hidden="true" />
          <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
          {live && <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Live</span>}
          {sub && <span className="text-xs text-slate-500">{sub}</span>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Panel({ title, hint, right, children, className = "", pad = true }: { title?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <div className={`panel flex flex-col ${className}`}>
      {(title || right) && (
        <header className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
          <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{title}</h3>{hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}</div>
          {right && <div className="shrink-0 text-xs">{right}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${pad ? "p-4" : ""}`}>{children}</div>
    </div>
  );
}

export const More = ({ href, children }: { href: string; children: ReactNode }) => <Link href={href} className="whitespace-nowrap text-xs font-medium">{children} →</Link>;

export function Quiet({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-sm text-slate-500">{children}</div>;
}

export function Avatar({ name, agent }: { name: string; agent?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  return (
    <span className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${agent ? "bg-brand-600 text-white" : "bg-brand-100 text-brand-900"}`} title={agent ? `${name} (AI agent)` : name}>
      {agent ? <Icon name="bot" /> : initials}
    </span>
  );
}

/* ---------- numbers ---------- */

/** Change against the period before, as a small chip. The arrow carries the direction; colour only says whether that is good. */
export function Delta({ cur, prev, goodUp = true, fmt = (n: number) => String(n) }: { cur: number | null; prev: number | null | undefined; goodUp?: boolean; fmt?: (n: number) => string }) {
  if (prev == null || cur == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">no change</span>;
  const good = d > 0 === goodUp;
  return <span className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}</span>;
}

/** A trend with no axis: the shape only. The number beside it carries the value. */
export function Sparkline({ values, className = "text-brand-500" }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const W = 100, H = 32, top = 3;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - (v / max) * (H - top)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`h-9 w-full ${className}`} aria-hidden="true">
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A headline number for the period: what it is, how much, how it changed, and its shape over time. */
export function KpiCard({ icon, tint, label, value, delta, sub, trend, href }: { icon: IconName; tint: string; label: string; value: ReactNode; delta?: ReactNode; sub?: ReactNode; trend?: number[]; href?: string }) {
  const body = (
    <div className={`panel flex h-full flex-col overflow-hidden transition ${href ? "hover:border-brand-500/50 hover:shadow-md" : ""}`}>
      <div className="flex flex-1 flex-col px-4 pt-3.5">
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${tint}`}><Icon name={icon} /></span>
          <span className="text-xs font-medium text-slate-600">{label}</span>
        </div>
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-[28px] font-semibold leading-none tracking-tight text-slate-900 tabular-nums">{value}</span>
          {delta}
        </div>
        <div className="min-h-4 pb-2 pt-1.5 text-xs text-slate-500">{sub}</div>
      </div>
      {trend && trend.length >= 2 ? <Sparkline values={trend} /> : <div className="h-2" />}
    </div>
  );
  return href ? <Link href={href} className="block text-inherit no-underline hover:no-underline">{body}</Link> : body;
}

/** A small figure inside a panel. */
export function Mini({ label, value, tone = "text-slate-900" }: { label: string; value: ReactNode; tone?: string }) {
  return <div><div className={`text-xl font-semibold leading-none tabular-nums ${tone}`}>{value}</div><div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div></div>;
}

/* ---------- charts ---------- */

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};
export type Series = { name: string; className: string };
export type Bucket = { label: string; values: number[] };

/** Columns over time on one y-axis. Several series stack, each keeping its fixed colour. Hover or focus a column for its numbers. */
export function Columns({ buckets, series, unit, height = "h-40", xLabels = true }: { buckets: Bucket[]; series: Series[]; unit: string; height?: string; xLabels?: boolean }) {
  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0));
  const peak = Math.max(0, ...totals);
  const max = niceMax(peak);
  const n = buckets.length;
  const sum = totals.reduce((a, v) => a + v, 0);
  const showAll = n <= 10;
  const ticks = showAll ? buckets.map((b) => b.label) : [buckets[0].label, buckets[Math.floor((n - 1) / 2)].label, buckets[n - 1].label];
  return (
    <div>
      <div className="flex gap-2">
        <div className={`flex w-7 flex-col justify-between text-right text-[10px] leading-none text-slate-400 tabular-nums ${height}`}><span>{max}</span><span>{max / 2}</span><span>0</span></div>
        <div className={`relative flex-1 ${height}`} role="img" aria-label={`${series.map((s) => s.name).join(" and ")}: ${sum} ${unit} in total, highest ${peak}.`}>
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between"><div className="border-t border-dashed border-slate-200" /><div className="border-t border-dashed border-slate-200" /><div className="border-t border-slate-300" /></div>
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {buckets.map((b, i) => {
              const top = b.values.reduce((last, v, k) => (v > 0 ? k : last), -1);
              const edge = i < n / 3 ? "left-0" : i > (2 * n) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
              return (
                <div key={i} tabIndex={0} className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded outline-none hover:bg-slate-100/70 focus-visible:bg-slate-100">
                  <div className="flex w-full max-w-9 flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 100}%` }}>
                    {b.values.map((v, k) => (v > 0 ? <div key={k} className={`${series[k].className} ${k === top ? "rounded-t-[4px]" : ""}`} style={{ flexGrow: v, flexBasis: 0 }} /> : null))}
                  </div>
                  <div className={`pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg group-hover:block group-focus-visible:block ${edge}`}>
                    <div className="font-medium">{b.label}</div>
                    {series.map((s, k) => <div key={s.name} className="flex items-center gap-1.5"><span className={`inline-block h-2 w-2 rounded-sm ${s.className}`} />{s.name}: <b>{b.values[k]}</b></div>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {xLabels && (
        <div className={`ml-9 mt-1.5 flex text-[10px] text-slate-500 ${showAll ? "gap-[3px]" : "justify-between"}`}>
          {ticks.map((t, i) => <span key={i} className={showAll ? "min-w-0 flex-1 truncate text-center" : ""}>{t}</span>)}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">{series.map((s) => <span key={s.name} className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.className}`} />{s.name}</span>)}</span>;
}

/** The same numbers as a table, so nothing depends on colour or on hovering. */
export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="text-slate-500">Show as table</summary>
      <div className="mt-1 max-h-56 overflow-auto">
        <table className="w-full tabular-nums">
          <thead><tr className="text-left text-slate-500">{head.map((h) => <th key={h} className="py-0.5 pr-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, k) => <td key={k} className={`py-0.5 pr-3 ${k ? "" : "text-slate-700"}`}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

/** Steps that narrow: each bar is a share of the first step, and the chip between two steps is the conversion. */
export function Funnel({ steps }: { steps: { label: string; value: number; href?: string }[] }) {
  const first = Math.max(steps[0]?.value ?? 0, 1);
  const shades = ["bg-brand-900", "bg-brand-700", "bg-brand-600", "bg-brand-500"];
  return (
    <ol className="flex h-full flex-col justify-between gap-1">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : null;
        const conv = prev ? `${((s.value / prev) * 100).toFixed(s.value / prev < 0.1 ? 1 : 0)}%` : null;
        const row = (
          <div className="rounded-md px-1 py-1 hover:bg-slate-50">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-600">{s.label}</span>
              <span className="text-lg font-semibold leading-none text-slate-900 tabular-nums">{s.value}</span>
            </div>
            <div className="mt-1.5 h-2.5 rounded-full bg-slate-100"><div className={`h-full rounded-full ${shades[Math.min(i, shades.length - 1)]}`} style={{ width: `${Math.min(100, (s.value / first) * 100)}%`, minWidth: s.value ? 6 : 0 }} /></div>
          </div>
        );
        return (
          <li key={s.label}>
            {i > 0 && <div className="mb-1 flex items-center gap-1.5 pl-1 text-[11px] text-slate-500"><span className="text-slate-300">↓</span>{conv ? <><b className="font-semibold text-slate-700">{conv}</b> of the step above</> : "—"}</div>}
            {s.href ? <Link href={s.href} className="block text-inherit no-underline hover:no-underline">{row}</Link> : row}
          </li>
        );
      })}
    </ol>
  );
}

/** Used and reserved against a daily limit, as a ring with the used count in the middle. */
export function Ring({ used, reserved, cap, tone = "ok" }: { used: number; reserved: number; cap: number | null; tone?: "ok" | "off" }) {
  const R = 25, C = 2 * Math.PI * R;
  const total = cap == null ? Math.max(used + reserved, 1) : Math.max(cap, used + reserved, 1);
  const u = (used / total) * C, r = (reserved / total) * C;
  return (
    <div className="relative h-16 w-16 shrink-0" role="img" aria-label={cap == null ? `${used} sent, ${reserved} approved and waiting, no daily limit` : `${used} sent and ${reserved} approved and waiting, of ${cap}`}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" strokeWidth="7" className={tone === "off" ? "stroke-slate-200" : "stroke-brand-100"} />
        {cap != null && reserved > 0 && <circle cx="32" cy="32" r={R} fill="none" strokeWidth="7" strokeDasharray={`${u + r} ${C}`} className={tone === "off" ? "stroke-slate-300" : "stroke-brand-500/50"} />}
        {cap != null && used > 0 && <circle cx="32" cy="32" r={R} fill="none" strokeWidth="7" strokeDasharray={`${u} ${C}`} className={tone === "off" ? "stroke-slate-400" : "stroke-brand-600"} />}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-base font-semibold text-slate-900 tabular-nums">{used}</span>
        <span className="mt-0.5 text-[10px] text-slate-500">{cap == null ? "no limit" : `of ${cap}`}</span>
      </div>
    </div>
  );
}

/** Parts of a whole on one line: each part keeps its own colour, with a small gap between parts. */
export function Segments({ parts, className = "h-2.5" }: { parts: { key: string; value: number; className: string; label?: string }[]; className?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <div className={`rounded-full bg-slate-100 ${className}`} />;
  return (
    <div className={`flex gap-[2px] overflow-hidden rounded-full ${className}`} role="img" aria-label={parts.filter((p) => p.value).map((p) => `${p.label ?? p.key}: ${p.value}`).join(", ")}>
      {parts.map((p) => (p.value > 0 ? <div key={p.key} className={p.className} style={{ flexGrow: p.value, flexBasis: 0, minWidth: 3 }} title={`${p.label ?? p.key}: ${p.value}`} /> : null))}
    </div>
  );
}

/** One row of an ordered bar list: name, bar on a shared baseline, value, and its share. */
export function BarRow({ label, value, max, total, href, tone = "bg-brand-600" }: { label: ReactNode; value: number; max: number; total?: number; href?: string; tone?: string }) {
  const row = (
    <div className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 rounded-md px-1.5 py-[5px] hover:bg-slate-50">
      <div className={`truncate text-[13px] ${value ? "text-slate-700" : "text-slate-400"}`}>{label}</div>
      <div className="h-2.5 rounded-full bg-slate-100"><div className={`h-full rounded-full ${tone}`} style={{ width: `${max ? (value / max) * 100 : 0}%`, minWidth: value ? 4 : 0 }} /></div>
      <div className="w-16 text-right text-[13px] tabular-nums"><b className={`font-semibold ${value ? "text-slate-900" : "text-slate-400"}`}>{value}</b>{total ? <span className="ml-1.5 text-[11px] text-slate-500">{Math.round((value / total) * 100)}%</span> : null}</div>
    </div>
  );
  return href ? <Link href={href} className="block text-inherit no-underline hover:no-underline">{row}</Link> : row;
}

/** A rate shown as a number with a short bar under it (0 to `scale`). */
export function RateBar({ rate, scale, tone = "bg-viz-3", warn }: { rate: number | null; scale: number; tone?: string; warn?: boolean }) {
  if (rate == null) return <span className="text-slate-400">—</span>;
  return (
    <div className="inline-flex w-20 flex-col items-stretch">
      <span className={`text-right text-[13px] font-semibold tabular-nums ${warn ? "text-red-700" : "text-slate-900"}`}>{(rate * 100).toFixed(1)}%</span>
      <span className="mt-1 h-1.5 rounded-full bg-slate-100"><span className={`block h-full rounded-full ${warn ? "bg-red-500" : tone}`} style={{ width: `${Math.min(100, (rate / scale) * 100)}%`, minWidth: rate ? 3 : 0 }} /></span>
    </div>
  );
}

export function Skeleton({ className = "h-40" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200/60 ${className}`} aria-busy="true" aria-label="Loading" />;
}
