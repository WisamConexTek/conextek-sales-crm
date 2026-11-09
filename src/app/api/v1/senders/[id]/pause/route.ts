import { route, id } from "@/lib/api";
import { pauseSender } from "@/lib/service/senders";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => pauseSender(actor, id(params.id), await body()));
