import Link from "next/link";
import type { ReactNode } from "react";

/* Dashboard figures and charts. Server-rendered, no client script: hover and keyboard focus use plain CSS. */

/** A headline number that is also a way in: the whole tile opens the records it counts. */
export function Tile({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: "red" | "amber" | "green" }) {
  const zero = value === 0;
  const color = zero ? "text-slate-400" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-emerald-600" : "text-slate-900";
  const edge = zero || !tone ? "border-l-slate-200" : tone === "red" ? "border-l-red-500" : tone === "amber" ? "border-l-amber-500" : "border-l-emerald-500";
  const body = (
    <div className={`card h-full border-l-4 p-3.5 transition ${edge} ${href ? "hover:border-slate-300 hover:shadow" : ""}`}>
      <div className="text-xs font-medium text-slate-600">{label}</div>
      <div className={`mt-1 text-3xl font-semibold leading-none ${color}`}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block no-underline hover:no-underline">{body}</Link> : body;
}

/** Change against the period before. The arrow carries the direction; colour only says whether that is good. */
export function Delta({ cur, prev, goodUp = true, fmt = (n: number) => String(n) }: { cur: number | null; prev: number | null | undefined; goodUp?: boolean; fmt?: (n: number) => string }) {
  if (prev == null || cur == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return <span className="text-slate-500">no change</span>;
  const good = d > 0 === goodUp;
  return <span className={good ? "text-emerald-700" : "text-red-700"}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}</span>;
}

/** A period figure: value, change, and what it was before. */
export function Kpi({ label, value, delta, sub }: { label: string; value: ReactNode; delta?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="text-xs font-medium text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-semibold leading-none text-slate-900">{value}</div>
      <div className="mt-1.5 min-h-4 text-xs text-slate-500">{delta}{delta && sub ? " · " : ""}{sub}</div>
    </div>
  );
}

/** Used and reserved against a daily limit. The empty track is a lighter step of the same colour. */
export function Meter({ used, reserved, cap }: { used: number; reserved: number; cap: number }) {
  const total = Math.max(cap, used + reserved, 1);
  const u = (used / total) * 100, r = (reserved / total) * 100;
  return (
    <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-brand-100" role="img" aria-label={`${used} sent and ${reserved} reserved of ${cap}`}>
      {used > 0 && <div className="h-full bg-brand-700" style={{ width: `${u}%` }} />}
      {reserved > 0 && <div className="h-full bg-brand-500/60" style={{ width: `${r}%` }} />}
    </div>
  );
}

/** One row of a ranked / ordered bar list: name, thin bar on a shared baseline, value at the tip. */
export function BarRow({ label, value, max, href, tone = "bg-brand-600", note }: { label: ReactNode; value: number; max: number; href?: string; tone?: string; note?: ReactNode }) {
  const row = (
    <div className="grid grid-cols-[9.5rem_1fr] items-center gap-3 rounded px-1 py-1 hover:bg-slate-50">
      <div className="truncate text-sm text-slate-700">{label}{note}</div>
      <div className="flex items-center gap-2">
        <div className={`h-2 rounded-r ${tone}`} style={{ width: `${max ? (value / max) * 88 : 0}%`, minWidth: value ? 2 : 0 }} />
        <span className="text-sm font-medium tabular-nums text-slate-900">{value}</span>
      </div>
    </div>
  );
  return href ? <Link href={href} className="block text-inherit no-underline hover:no-underline">{row}</Link> : row;
}

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/**
 * Columns over time, one y-axis. Several series stack (each keeps its fixed colour); hover or focus a column for its numbers.
 * A table of the same numbers sits underneath, so nothing depends on colour or on hovering.
 */
export function ColumnChart({ title, buckets, series, unit }: { title: string; buckets: { label: string; values: number[] }[]; series: { name: string; className: string }[]; unit: string }) {
  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0));
  const peak = Math.max(0, ...totals);
  const max = niceMax(peak);
  const n = buckets.length;
  const sum = totals.reduce((a, v) => a + v, 0);
  const showAll = n <= 8;
  const ticks = showAll ? buckets.map((b) => b.label) : [buckets[0].label, buckets[Math.floor((n - 1) / 2)].label, buckets[n - 1].label];
  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{title}</span>
        {series.length > 1 && (
          <span className="flex gap-3 text-xs text-slate-600">
            {series.map((s) => <span key={s.name} className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.className}`} />{s.name}</span>)}
          </span>
        )}
      </figcaption>
      {peak === 0 ? <p className="py-8 text-center text-sm text-slate-500">No {unit} recorded in this period.</p> : (
        <>
          <div className="flex gap-2">
            <div className="flex h-32 w-6 flex-col justify-between text-right text-[10px] tabular-nums leading-none text-slate-500"><span>{max}</span><span>{max / 2}</span><span>0</span></div>
            <div className="relative h-32 flex-1" role="img" aria-label={`${title}: ${sum} ${unit} in total, highest ${peak}. The table below has every value.`}>
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between"><div className="border-t border-slate-100" /><div className="border-t border-slate-100" /><div className="border-t border-slate-300" /></div>
              <div className="absolute inset-0 flex items-end gap-[2px]">
                {buckets.map((b, i) => {
                  const top = b.values.reduce((last, v, k) => (v > 0 ? k : last), -1);
                  const edge = i < n / 3 ? "left-0" : i > (2 * n) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
                  return (
                    <div key={i} tabIndex={0} className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none hover:bg-slate-50 focus-visible:bg-slate-100">
                      <div className="flex w-full max-w-6 flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 100}%` }}>
                        {b.values.map((v, k) => (v > 0 ? <div key={k} className={`${series[k].className} ${k === top ? "rounded-t" : ""}`} style={{ flexGrow: v, flexBasis: 0 }} /> : null))}
                      </div>
                      <div className={`pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow group-hover:block group-focus-visible:block ${edge}`}>
                        <div className="font-medium">{b.label}</div>
                        {series.map((s, k) => <div key={s.name}>{series.length > 1 ? `${s.name}: ` : ""}{b.values[k]}{series.length === 1 ? ` ${unit}` : ""}</div>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className={`ml-8 mt-1 flex text-[10px] text-slate-500 ${showAll ? "gap-[2px]" : "justify-between"}`}>
            {ticks.map((t, i) => <span key={i} className={showAll ? "min-w-0 flex-1 truncate text-center" : ""}>{t}</span>)}
          </div>
        </>
      )}
      {peak > 0 && (
        <details className="mt-2 text-xs">
          <summary className="text-slate-500">Show as table</summary>
          <div className="mt-1 max-h-56 overflow-auto">
            <table className="w-full tabular-nums">
              <thead><tr className="text-left text-slate-500"><th className="py-0.5 pr-3 font-medium">Period</th>{series.map((s) => <th key={s.name} className="pr-3 font-medium">{s.name}</th>)}</tr></thead>
              <tbody>{buckets.map((b, i) => <tr key={i} className="border-t border-slate-100"><td className="py-0.5 pr-3 text-slate-700">{b.label}</td>{b.values.map((v, k) => <td key={k} className="pr-3">{v}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

export function Skeleton({ className = "h-40" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-100 ${className}`} aria-busy="true" aria-label="Loading" />;
}
