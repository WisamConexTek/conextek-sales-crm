import { route, id } from "@/lib/api";
import { addContact } from "@/lib/service/leads";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => ({ id: await addContact(actor, id(params.id), await body()) }));
