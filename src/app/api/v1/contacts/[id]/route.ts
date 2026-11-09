import { route, id } from "@/lib/api";
import { updateContact, getContact } from "@/lib/service/leads";
export const GET = route<{ id: string }>(async ({ actor, params }) => getContact(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateContact(actor, id(params.id), await body());
  return { updated: true, contact: await getContact(actor, id(params.id)) };
});
