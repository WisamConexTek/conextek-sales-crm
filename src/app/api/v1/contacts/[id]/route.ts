import { route, id } from "@/lib/api";
import { updateContact } from "@/lib/service/leads";
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateContact(actor, id(params.id), await body());
  return { updated: true };
});
