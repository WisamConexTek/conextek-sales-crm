import { route, id } from "@/lib/api";
import { assertLeadAccess } from "@/lib/service/leads";
import { getLeadSequence, controlSequence } from "@/lib/service/sequences";
export const GET = route<{ id: string }>(async ({ actor, params }) => { await assertLeadAccess(actor, id(params.id)); return { lead_id: id(params.id), sequences: await getLeadSequence(id(params.id)) }; });
// {action: "pause" | "resume" | "stop", reason, channel?, resume_on?}  Owner and Chief.
export const POST = route<{ id: string }>(async ({ actor, params, body }) => { await assertLeadAccess(actor, id(params.id)); return controlSequence(actor, id(params.id), await body()); });
