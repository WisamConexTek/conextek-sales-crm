"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; badge?: number };

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((i) => {
        const active = i.href === "/" ? path === "/" : path === i.href || path.startsWith(i.href + "/");
        return (
          <Link key={i.href} href={i.href}
            className={`flex items-center justify-between rounded-md px-3 py-2 text-sm no-underline hover:no-underline ${active ? "bg-white/20 font-semibold text-white! shadow-[inset_3px_0_0_var(--color-accent)]" : "text-white/85! hover:bg-white/10"}`}>
            <span>{i.label}</span>
            {!!i.badge && <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-brand-900">{i.badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
