import { route, num } from "@/lib/api";
import { schedule } from "@/lib/service/schedule";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  const v = p.get("view");
  return schedule(actor, {
    view: v === "tomorrow" ? "tomorrow" : v === "today" ? "today" : undefined, date: p.get("date") ?? undefined, from: p.get("from") ?? undefined, to: p.get("to") ?? undefined,
    employee: num(p.get("employee")), project: num(p.get("project")), campaign: num(p.get("campaign")), channel: p.get("channel") ?? undefined, state: p.get("state") ?? undefined, includeTest: p.get("include_test") === "1",
  });
});
