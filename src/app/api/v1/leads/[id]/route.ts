import { route, id } from "@/lib/api";
import { getLead, updateLead } from "@/lib/service/leads";
export const GET = route<{ id: string }>(async ({ actor, params }) => getLead(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateLead(actor, id(params.id), await body());
  return { updated: true };
});
