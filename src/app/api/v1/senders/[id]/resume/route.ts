import { route, id } from "@/lib/api";
import { resumeSender } from "@/lib/service/senders";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => resumeSender(actor, id(params.id), await body()));
