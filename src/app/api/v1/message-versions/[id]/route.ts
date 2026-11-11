import { route, id } from "@/lib/api";
import { getVersion } from "@/lib/service/sends";
/** Same as GET /messages/versions/{id}: one draft with its text, approvals and decisions. */
export const GET = route<{ id: string }>(async ({ actor, params }) => getVersion(actor, id(params.id)));
