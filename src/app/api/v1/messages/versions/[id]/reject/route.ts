import { route, id } from "@/lib/api";
import { rejectVersion } from "@/lib/service/sends";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => rejectVersion(actor, id(params.id), ((await body()) as { reason?: unknown })?.reason));
