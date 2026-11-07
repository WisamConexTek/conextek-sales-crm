import { route, id } from "@/lib/api";
import { getTask, updateTask } from "@/lib/service/tasks";
export const GET = route<{ id: string }>(async ({ actor, params }) => getTask(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateTask(actor, id(params.id), await body());
  return { updated: true };
});
