/**
 * One sort syntax for every list: sort=field (ascending) or sort=-field (descending).
 * Empty values go last in both directions; numbers and dates sort as numbers and dates, text ignores case.
 */
export type SortValue = string | number | null | undefined;
export type SortSpec<T> = Record<string, (row: T) => SortValue>;
export type ParsedSort = { field: string | null; desc: boolean; applied: string | null; warning: string | null };

export function parseSort(raw: string | null | undefined, fields: readonly string[], aliases: Record<string, string> = {}, fallback: string | null = null): ParsedSort {
  const v = (raw ?? "").trim();
  const parse = (s: string) => { const desc = s.startsWith("-"); return { field: desc ? s.slice(1) : s, desc }; };
  if (v) {
    const p = parse(aliases[v] ?? v);
    if (fields.includes(p.field)) return { ...p, applied: `${p.desc ? "-" : ""}${p.field}`, warning: null };
  }
  const f = fallback ? parse(fallback) : null;
  return { field: f?.field ?? null, desc: f?.desc ?? false, applied: fallback,
    warning: v ? `sort: "${v}" is not a sortable field, so the default order was used. Use one of: ${fields.join(", ")} (put "-" in front for descending).` : null };
}

const empty = (v: SortValue) => v === null || v === undefined || v === "";
export function compareValues(a: SortValue, b: SortValue, desc = false): number {
  const ea = empty(a), eb = empty(b);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en", { sensitivity: "base", numeric: true });
  return desc ? -c : c;
}
/** Stable sort of rows that are already complete in memory. */
export function sortRows<T>(rows: T[], spec: SortSpec<T>, sort: ParsedSort): T[] {
  if (!sort.field || !spec[sort.field]) return rows;
  const get = spec[sort.field];
  return rows.map((r, i) => ({ r, i })).sort((x, y) => compareValues(get(x.r), get(y.r), sort.desc) || x.i - y.i).map((x) => x.r);
}
/** The next value of ?sort= when a header is clicked: ascending, then descending, then back to the page's default. */
export const nextSort = (current: string | null | undefined, field: string): string | undefined => (current === field ? `-${field}` : current === `-${field}` ? undefined : field);
