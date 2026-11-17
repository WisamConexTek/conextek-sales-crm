import { route, id } from "@/lib/api";
import { updateSequence } from "@/lib/service/sequences";
// Replaces the steps. It creates a new version: leads already in the sequence keep the version they started with.
export const PUT = route<{ id: string }>(async ({ actor, params, body }) => { const b = await body(); return updateSequence(actor, id(params.id), { steps: b.steps, reason: b.reason }); });
