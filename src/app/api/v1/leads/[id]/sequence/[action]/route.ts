import { route, id } from "@/lib/api";
import { assertLeadAccess } from "@/lib/service/leads";
import { controlSequence } from "@/lib/service/sequences";
// POST /leads/{id}/sequence/pause | resume | stop   {reason, channel?, resume_on?}
export const POST = route<{ id: string; action: string }>(async ({ actor, params, body }) => { await assertLeadAccess(actor, id(params.id)); return controlSequence(actor, id(params.id), { ...(await body()), action: params.action }); });
