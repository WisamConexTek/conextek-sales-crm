import { route, id } from "@/lib/api";
import { getTaskDetail, updateTask } from "@/lib/service/tasks";
export const GET = route<{ id: string }>(async ({ actor, params }) => getTaskDetail(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateTask(actor, id(params.id), await body());
  return { updated: true };
});
