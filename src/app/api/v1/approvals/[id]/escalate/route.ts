import { route, id } from "@/lib/api";
import { escalateApproval } from "@/lib/service/tasks";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => {
  await escalateApproval(actor, id(params.id), String((await body()).comment ?? ""));
  return { escalated: true };
});
