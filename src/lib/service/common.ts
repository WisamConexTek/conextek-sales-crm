import { z } from "zod";
import { run, now, all, localMidnight, addDays, todayYmd } from "../db";
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

/**
 * Accepts full ISO (with Z/offset), "YYYY-MM-DDTHH:mm" (read in APP_TIMEZONE) or "YYYY-MM-DD"
 * (a due date: counts as due at the END of that day in APP_TIMEZONE). Returns ISO or null.
 */
export function parseWhen(v: unknown): string | null | "invalid" {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) return new Date(localMidnight(addDays(m[1], 1)).getTime() - 60000).toISOString();
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return new Date(localMidnight(m[1]).getTime() + (Number(m[2]) * 60 + Number(m[3])) * 60000).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? "invalid" : d.toISOString();
}
/**
 * Date of something that HAPPENED (a lead's origin, a send, a reply, a bounce).
 *  - "YYYY-MM-DD"           -> that day, no hour (stored as local midnight, precision "day")
 *  - "YYYY-MM-DDTHH:mm" / full ISO -> exact moment (precision "time")
 *  - empty / null / "unknown"      -> unknown (never replaced by today)
 */
export type EventDate = { at: string | null; precision: "day" | "time" | "unknown" };
export function parseEventDate(v: unknown): EventDate | "invalid" {
  if (v == null) return { at: null, precision: "unknown" };
  const s = String(v).trim();
  if (s === "" || /^unknown$/i.test(s)) return { at: null, precision: "unknown" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = localMidnight(s);
    return isNaN(d.getTime()) || todayYmd(undefined, d) !== s ? "invalid" : { at: d.toISOString(), precision: "day" };
  }
  const w = parseWhen(s);
  return w === "invalid" || w === null ? "invalid" : { at: w, precision: "time" };
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
