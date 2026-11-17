import Link from "next/link";
import type { ReactNode } from "react";
import { nextSort } from "@/lib/sort";

/**
 * A sortable column header. First click sorts ascending, the second descending, the third returns to the page's default order.
 * `href` builds the page URL for a given sort value, so the sort always lives in the address bar.
 */
export function SortTh({ label, field, sort, href, className = "", align, name }: { label: ReactNode; field: string; sort?: string | null; href: (sort?: string) => string; className?: string; align?: "right"; name?: string }) {
  const asc = sort === field, desc = sort === `-${field}`;
  const next = nextSort(sort, field);
  const what = name ?? (typeof label === "string" ? label.toLowerCase() : field);
  return (
    <th className={`th ${align === "right" ? "text-right" : ""} ${className}`} aria-sort={asc ? "ascending" : desc ? "descending" : "none"}>
      <Link href={href(next)} scroll={false} aria-label={`Sort by ${what}, ${asc ? "descending" : desc ? "default order" : "ascending"}`}
        className={`group inline-flex items-center gap-1 no-underline hover:no-underline ${asc || desc ? "text-brand-700!" : "text-slate-500! hover:text-slate-800!"}`}>
        <span>{label}</span>
        <span aria-hidden="true" className={`text-[10px] leading-none ${asc || desc ? "" : "opacity-0 group-hover:opacity-50 group-focus-visible:opacity-50"}`}>{desc ? "▼" : "▲"}</span>
      </Link>
    </th>
  );
}
