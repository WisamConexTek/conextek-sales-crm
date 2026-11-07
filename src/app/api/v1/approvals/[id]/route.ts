import { route, id } from "@/lib/api";
import { getApproval } from "@/lib/service/tasks";
export const GET = route<{ id: string }>(async ({ actor, params }) => getApproval(actor, id(params.id)));
