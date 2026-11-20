import { route, id } from "@/lib/api";
import { reopenTask } from "@/lib/service/tasks";
// Owner or Chief: {reason}. Reopens a task that was closed by mistake.
export const POST = route<{ id: string }>(async ({ actor, params, body }) => reopenTask(actor, id(params.id), await body()));
