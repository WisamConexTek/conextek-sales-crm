import { route, num } from "@/lib/api";
import { listTasks, createTask } from "@/lib/service/tasks";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return listTasks(actor, { assignee: num(p.get("assignee")), status: p.get("status") ?? undefined, lead: num(p.get("lead")), overdue: p.get("overdue") === "1", open: p.get("open") === "1", includeDemo: p.get("include_test") !== "0" });
});
export const POST = route(async ({ actor, body }) => ({ id: await createTask(actor, await body()) }));
