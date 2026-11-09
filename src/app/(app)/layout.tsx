import { cookies } from "next/headers";
import { requireUser, can, isManager } from "@/lib/auth";
import { one } from "@/lib/db";
import { cached } from "@/lib/ttl-cache";
import { canAuthorizeSend, countPendingSendApprovals } from "@/lib/service/sends";
import { logoutAction, toggleDemoAction } from "@/app/actions";
import { Nav, type NavItem } from "@/components/Nav";
import Link from "next/link";
import Image from "next/image";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireUser({ allowPasswordChange: true });
  // Everything the menu needs, in ONE parallel round trip, cached for a few seconds per person (the web actions clear it).
  const nav = await cached(`nav:${me.id}:${me.role}`, 5000, async () => {
    const canSend = await canAuthorizeSend(me);
    const [mine, toDecide, demo, sendPending] = await Promise.all([
      one("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND is_demo=0 AND status IN ('todo','in_progress','changes_requested','approved')", [me.id]),
      can(me, "approvals.decide") ? one(`SELECT COUNT(*) n FROM approvals WHERE is_demo=0 AND status='pending' AND submitted_by<>? ${me.role === "owner" ? "" : "AND requires='chief'"}`, [me.id]) : Promise.resolve({ n: 0 }),
      one("SELECT (SELECT COUNT(*) FROM leads WHERE is_demo=1) + (SELECT COUNT(*) FROM tasks WHERE is_demo=1) AS n"),
      canSend ? countPendingSendApprovals() : Promise.resolve(null),
    ]);
    return { mine: Number(mine!.n), toDecide: Number(toDecide!.n), hasDemo: Number(demo!.n) > 0, canSend, sendPending: sendPending as number | null };
  });
  const { mine, toDecide, hasDemo } = nav;
  const hidden = (await cookies()).get("crm_hide_test")?.value === "1";

  const items: NavItem[] = [
    { href: "/", label: "Dashboard" },
    { href: "/leads", label: "Leads" },
    { href: "/my-work", label: "My Work", badge: mine },
    { href: "/schedule", label: "Today & Tomorrow" },
    { href: "/approvals", label: "Approvals", badge: toDecide },
    ...(nav.canSend ? [{ href: "/send-approvals", label: "Send approvals", badge: nav.sendPending ?? 0 }] : []),
    { href: "/reports", label: can(me, "reports.view") || isManager(me) ? "Reports" : "My numbers" },
  ];
  if (can(me, "campaigns.manage") || can(me, "reports.view") || isManager(me)) items.push({ href: "/campaigns", label: "Campaigns" });
  if (isManager(me)) items.push({ href: "/settings", label: "Settings & Permissions" });
  if (can(me, "history.import")) items.push({ href: "/settings/history", label: "Historical data" });
  items.push({ href: "/api-docs", label: "API guide" });

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-brand-600 p-3 md:flex">
        <div className="mb-4 px-2 pt-1">
          <Link href="/"><Image src="/logo-light.png" alt="ConexTek" width={530} height={270} priority className="h-auto w-44" /></Link>
          <div className="mt-1 text-center text-[11px] uppercase tracking-widest text-white/70">Sales CRM</div>
        </div>
        <Nav items={items} />
        <div className="mt-auto space-y-2 border-t border-white/20 pt-3">
          {hasDemo && (
            <form action={toggleDemoAction}>
              <input type="hidden" name="_back" value="/" />
              <button className="btn btn-sm w-full">{hidden ? "Show test data" : "Hide test data"}</button>
            </form>
          )}
          <div className="px-1 text-sm">
            <div className="font-medium text-white">{me.name}</div>
            <div className="text-xs capitalize text-white/70">{me.role}</div>
          </div>
          <div className="flex gap-2">
            <Link href="/account" className="btn btn-sm flex-1">Account</Link>
            <form action={logoutAction} className="flex-1"><button className="btn btn-sm w-full">Sign out</button></form>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between bg-brand-600 px-4 py-2 md:hidden">
          <Image src="/logo-light.png" alt="ConexTek" width={530} height={270} className="h-9 w-auto" />
          <form action={logoutAction}><button className="btn btn-sm">Sign out</button></form>
        </div>
        <div className="overflow-x-auto border-b border-slate-200 bg-white px-2 py-1 md:hidden">
          <div className="flex gap-1 whitespace-nowrap text-sm">{items.map((i) => <Link key={i.href} href={i.href} className="rounded px-2 py-1 text-slate-700">{i.label}{i.badge ? ` (${i.badge})` : ""}</Link>)}</div>
        </div>
        {hasDemo && !hidden && <div className="bg-accent/90 px-6 py-1.5 text-xs font-semibold text-brand-900">Test records are shown and labelled TEST. They are excluded from every dashboard and report number.</div>}
        <main className="mx-auto max-w-[1400px] p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
