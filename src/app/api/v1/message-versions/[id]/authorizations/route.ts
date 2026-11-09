import { route, id } from "@/lib/api";
import { versionAuthorizations } from "@/lib/service/sends";
export const GET = route<{ id: string }>(async ({ actor, params }) => versionAuthorizations(actor, id(params.id)));
