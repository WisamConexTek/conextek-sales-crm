import { route, id } from "@/lib/api";
import { rescheduleTask } from "@/lib/service/tasks";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => rescheduleTask(actor, id(params.id), await body()));
