import { route, id } from "@/lib/api";
import { submitTask } from "@/lib/service/tasks";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => ({ approval_id: await submitTask(actor, id(params.id), await body()) }));
