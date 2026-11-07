import { route, id } from "@/lib/api";
import { decideApproval } from "@/lib/service/tasks";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => {
  await decideApproval(actor, id(params.id), await body());
  return { decided: true };
});
