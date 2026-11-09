import { route, id } from "@/lib/api";
import { addContactDetailed } from "@/lib/service/leads";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => addContactDetailed(actor, id(params.id), await body()));
