import { route, id } from "@/lib/api";
import { getSender, updateSender } from "@/lib/service/senders";
export const GET = route<{ id: string }>(async ({ params }) => getSender(id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => updateSender(actor, id(params.id), await body()));
