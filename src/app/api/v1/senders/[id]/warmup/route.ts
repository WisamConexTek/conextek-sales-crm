import { route, id } from "@/lib/api";
import { setWarmup } from "@/lib/service/senders";
export const PUT = route<{ id: string }>(async ({ actor, params, body }) => setWarmup(actor, id(params.id), await body()));
