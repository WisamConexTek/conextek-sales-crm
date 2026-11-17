import { route, num } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { createTask } from "@/lib/service/tasks";
import { listTasksView, assertAssignee } from "@/lib/service/tasklist";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  const paged = !!(p.get("page") || p.get("page_size"));
  const id = (k: string): number | "none" | undefined => (p.get(k) === "none" ? "none" : num(p.get(k)));
  const r = await listTasksView(actor, {
    assignee: assertAssignee(actor, p.get("assignee")), lead: num(p.get("lead")), q: p.get("q") ?? undefined, includeTest: p.get("include_test") !== "0",
    status: p.get("open") === "1" ? "open" : p.get("status") ?? "all", state: p.get("state") ?? undefined, overdue: p.get("overdue") === "1", blocked: p.get("blocked") === "1",
    types: [...p.getAll("type"), ...p.getAll("action_type")].flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean), campaign: id("campaign_id"), sender: id("sender_id"),
    due: p.get("due") ?? undefined, daysOverdue: p.get("days_overdue")?.replace("8plus", "8+") ?? undefined, kind: p.get("kind") ?? undefined, sort: p.get("sort") ?? undefined, page: num(p.get("page")), pageSize: num(p.get("page_size")),
  });
  if (p.get("strict") === "1" && r.warnings.length) throw new HttpError(400, r.warnings.join(" "), "invalid_filter");
  // ?page= / ?page_size= give a paged answer {rows,total,page,page_size,has_more,applied_sort,warnings}. Without them the whole list is returned as an array, as before.
  if (!paged) return r.all;
  const { all: _all, ...rest } = r;
  void _all;
  return rest;
});
export const POST = route(async ({ actor, body }) => ({ id: await createTask(actor, await body()) }));
