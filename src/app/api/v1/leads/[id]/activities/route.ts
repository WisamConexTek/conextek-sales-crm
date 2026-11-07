import { route, id } from "@/lib/api";
import { recordActivity } from "@/lib/service/activities";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => recordActivity(actor, id(params.id), await body()));
