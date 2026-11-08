import { route, id } from "@/lib/api";
import { getVersion } from "@/lib/service/sends";
export const GET = route<{ id: string }>(async ({ actor, params }) => getVersion(actor, id(params.id)));
