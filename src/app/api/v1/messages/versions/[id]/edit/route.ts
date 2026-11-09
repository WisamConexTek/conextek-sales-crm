import { route, id } from "@/lib/api";
import { editVersion } from "@/lib/service/sends";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => editVersion(actor, id(params.id), await body()));
