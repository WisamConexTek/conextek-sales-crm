import { z } from "zod";
import { run, now, all, localMidnight, addDays, todayYmd, localInstant } from "../db";
import { HttpError, type Actor } from "../auth";

/** Write an entry to the read-only change history. */
export async function audit(actor: Actor, action: string, entity: string, entityId: number | string | null, detail?: unknown) {
  await run(
    "INSERT INTO audit_log (actor_id,actor_name,via,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [actor.id || null, actor.name, actor.via, action, entity, entityId == null ? null : String(entityId), detail === undefined ? null : JSON.stringify(detail), now()],
  );
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i.path.join(".") || "input"}: ${i.message}`);
  }
  return r.data;
}

/** Optional text: "" / undefined / null -> null. */
export const optText = (max = 4000) =>
  z.preprocess((v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null), z.string().max(max).nullable());
export const reqText = (max = 300) => z.string().trim().min(1, "required").max(max);
export const optInt = z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().nullable());
export const optBool = z.preprocess((v) => v === true || v === "true" || v === "on" || v === "1" || v === 1, z.boolean());

/** Zone-less: YYYY-MM-DD[T ]HH:mm[:ss[.fff]]   Explicit: the same followed by Z or a numeric offset (+08:00, +0800, +08). */
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const EXPLICIT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const realDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const validClock = (h: number, mi: number, s: number) => h < 24 && mi < 60 && s < 60;

/** An explicit-zone input keeps its EXACT instant; APP_TIMEZONE plays no part. null = not an explicit-zone string; "invalid" = malformed. */
function parseExplicit(s: string): string | null | "invalid" {
  const m = EXPLICIT.exec(s);
  if (!m) return null;
  const [, ymd, hh, mm, ss, ms, zone] = m;
  const h = +hh, mi = +mm, sec = ss ? +ss : 0;
  if (!realDate(ymd) || !validClock(h, mi, sec)) return "invalid";
  let offMin = 0;
  if (zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2, 4) : 0;
    if (oh > 14 || om > 59) return "invalid";
    offMin = sign * (oh * 60 + om);
  }
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms ? +ms.padEnd(3, "0") : 0) - offMin * 60000).toISOString();
}

/**
 * Accepts: "YYYY-MM-DD" (a due date: due at the END of that day in APP_TIMEZONE); "YYYY-MM-DDTHH:mm[:ss]" read in APP_TIMEZONE
 * with the offset valid at that moment (an hour that happens twice takes the first, one that is skipped moves forward);
 * or an ISO time with Z / numeric offset (exact instant). Returns ISO, null (blank) or "invalid".
 */
export function parseWhen(v: unknown): string | null | "invalid" {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (day) return realDate(day[1]) ? new Date(localMidnight(addDays(day[1], 1)).getTime() - 60000).toISOString() : "invalid";
  const ex = parseExplicit(s);
  if (ex !== null) return ex;
  const m = ZONELESS.exec(s);
  if (m) {
    const h = +m[2], mi = +m[3], sec = m[4] ? +m[4] : 0;
    if (!realDate(m[1]) || !validClock(h, mi, sec)) return "invalid";
    return new Date(localInstant(m[1], h, mi, sec).instant + (m[5] ? +m[5].padEnd(3, "0") : 0)).toISOString();
  }
  return "invalid";
}
/**
 * Date of something that HAPPENED (a lead's origin, a send, a reply, a bounce).
 *  - "YYYY-MM-DD"           -> that day, no hour (stored as local midnight, precision "day")
 *  - "YYYY-MM-DDTHH:mm" / full ISO -> exact moment (precision "time")
 *  - empty / null / "unknown"      -> unknown (never replaced by today)
 */
export type EventDate = { at: string | null; precision: "day" | "time" | "unknown" };
export type DateProblem = "invalid" | "ambiguous" | "nonexistent";
export function parseEventDate(v: unknown): EventDate | DateProblem {
  if (v == null) return { at: null, precision: "unknown" };
  const s = String(v).trim();
  if (s === "" || /^unknown$/i.test(s)) return { at: null, precision: "unknown" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!realDate(s)) return "invalid";
    const d = localMidnight(s);
    return isNaN(d.getTime()) || todayYmd(undefined, d) !== s ? "invalid" : { at: d.toISOString(), precision: "day" };
  }
  const ex = parseExplicit(s);
  if (ex === "invalid") return "invalid";
  if (ex) return { at: ex, precision: "time" };
  const m = ZONELESS.exec(s);
  if (!m) return "invalid";
  const h = +m[2], mi = +m[3], sec = m[4] ? +m[4] : 0;
  if (!realDate(m[1]) || !validClock(h, mi, sec)) return "invalid";
  // A zone-less time that falls in a clock change is refused rather than guessed: send Z or an offset instead.
  const li = localInstant(m[1], h, mi, sec);
  if (li.status !== "ok") return li.status;
  return { at: new Date(li.instant + (m[5] ? +m[5].padEnd(3, "0") : 0)).toISOString(), precision: "time" };
}
export function dateProblem(p: DateProblem, field: string): string {
  if (p === "ambiguous") return `${field}: that clock time happens twice in the application timezone (clocks go back). Say which one by sending an explicit instant, e.g. "2026-10-24T01:30:00+03:00" or "...Z".`;
  if (p === "nonexistent") return `${field}: that clock time does not exist in the application timezone (clocks go forward). Send an explicit instant, e.g. "...+02:00" or "...Z".`;
  return `${field}: use YYYY-MM-DD (date only), YYYY-MM-DDTHH:mm[:ss] (read in the application timezone), an ISO time with Z or an offset such as 2026-10-24T10:12:00+08:00, or "unknown".`;
}
/** Show an event date the way it was recorded: day-only dates carry no hour. */
export function eventDateText(at: string | null | undefined, precision: string | null | undefined): string {
  if (!at || precision === "unknown") return "";
  return precision === "day" ? todayYmd(undefined, new Date(at)) : at;
}

export const optDate = z.preprocess(parseWhen, z.string().nullable().refine((v) => v !== "invalid", "invalid date"));

export function domainOf(website?: string | null): string | null {
  if (!website) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

export async function activeKeys(kind: string): Promise<Set<string>> {
  return new Set((await all("SELECT key FROM lists WHERE kind=? AND active=1", [kind])).map((r) => r.key));
}
export async function assertListKey(kind: string, key: string | null | undefined, field: string) {
  if (!key) return;
  if (!(await activeKeys(kind)).has(key)) throw new HttpError(400, `${field}: "${key}" is not an active ${kind}. See GET /api/v1/lists.`);
}
