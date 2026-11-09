import { route, num } from "@/lib/api";
import { listTasks, listTasksPaged, createTask } from "@/lib/service/tasks";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  const filters = { assignee: num(p.get("assignee")), status: p.get("status") ?? undefined, lead: num(p.get("lead")), overdue: p.get("overdue") === "1", open: p.get("open") === "1", includeDemo: p.get("include_test") !== "0", q: p.get("q") ?? undefined, page: num(p.get("page")), pageSize: num(p.get("page_size")) };
  // ?page= / ?page_size= switch to a paged answer {rows,page,page_size,has_more} (50 per page); ?q= searches title and company. Without paging params the list is returned as before.
  return p.get("page") || p.get("page_size") ? listTasksPaged(actor, filters) : listTasks(actor, filters);
});
export const POST = route(async ({ actor, body }) => ({ id: await createTask(actor, await body()) }));
