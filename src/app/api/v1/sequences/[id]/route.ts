import { route, id } from "@/lib/api";
import { getSequence, updateSequence } from "@/lib/service/sequences";
export const GET = route<{ id: string }>(async ({ params }) => getSequence(id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => updateSequence(actor, id(params.id), await body()));
