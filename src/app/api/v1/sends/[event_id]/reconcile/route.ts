import { route } from "@/lib/api";
import { reconcileSend } from "@/lib/service/sends";
export const POST = route<{ event_id: string }>(async ({ actor, params }) => reconcileSend(actor, decodeURIComponent(params.event_id)));
