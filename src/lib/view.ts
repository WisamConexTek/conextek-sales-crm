import { cookies } from "next/headers";
import { all } from "./db";
import { first } from "./format";

export type SP = Promise<Record<string, string | string[] | undefined>>;
/** Test records are shown (clearly labelled) unless the user chose to hide them. They never count in reports. */
export const demoOn = async () => (await cookies()).get("crm_hide_test")?.value !== "1";
export const sget = (sp: Record<string, string | string[] | undefined>, k: string) => first(sp[k]) || undefined;
export const snum = (sp: Record<string, string | string[] | undefined>, k: string) => {
  const v = sget(sp, k);
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
};
export async function stageMeta() {
  const rows = await all("SELECT key,label,flag,active FROM lists WHERE kind='stage' ORDER BY position,id");
  return { rows, byKey: Object.fromEntries(rows.map((r) => [r.key, r])) as Record<string, { key: string; label: string; flag: string | null; active: number }> };
}
export const q = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
