import { route, id } from "@/lib/api";
import { reclassifyReply } from "@/lib/service/inbound";
// {classification, reason}: the effects of the new class run again and are listed in the answer.
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => reclassifyReply(actor, id(params.id), await body()));
