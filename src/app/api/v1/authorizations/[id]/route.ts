import { route, id } from "@/lib/api";
import { revoke } from "@/lib/service/sends";
export const DELETE = route<{ id: string }>(async ({ actor, params }) => { await revoke(actor, id(params.id)); return { revoked: true }; });
