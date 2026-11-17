import { route, id } from "@/lib/api";
import { updateSequence } from "@/lib/service/sequences";
export const POST = route<{ id: string }>(async ({ actor, params }) => updateSequence(actor, id(params.id), { status: "active" }));
