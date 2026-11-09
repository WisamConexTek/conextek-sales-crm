import { TZ } from "./db";

const fmt = (o: Intl.DateTimeFormatOptions, iso?: string | null) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), ...o }).format(new Date(iso)) : "—";

export const fmtDateTime = (iso?: string | null) => fmt({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }, iso);
export const fmtDate = (iso?: string | null) => fmt({ day: "numeric", month: "short", year: "numeric" }, iso);
export const fmtShort = (iso?: string | null) => fmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }, iso);
/** Value for <input type="datetime-local"> in app timezone. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return p.replace(" ", "T");
}
export const isOverdue = (iso?: string | null) => !!iso && new Date(iso).getTime() < Date.now();
export const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
export const first = <T,>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);
/** A date of something that happened: unknown stays "Unknown"; day-only dates show no hour. */
export const fmtEvent = (iso?: string | null, precision?: string | null) =>
  !iso || precision === "unknown" ? "Date unknown" : precision === "day" ? fmtDate(iso) : fmtDateTime(iso);
/** Value for <input type="date"> in app timezone ("" when unknown). */
export function toDateInput(iso?: string | null): string {
  return iso ? toLocalInput(iso).slice(0, 10) : "";
}

/** Date-only deadlines are stored as 23:59 local on that day; that is not a scheduled time of day. */
export function isDateOnlyTime(iso?: string | null): boolean {
  return !!iso && toLocalInput(iso).endsWith("T23:59");
}

/** A pure date (YYYY-MM-DD) shown as a date, with no timezone shift and no time. */
export const fmtYmd = (ymd?: string | null) => (ymd ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`)) : "—");
