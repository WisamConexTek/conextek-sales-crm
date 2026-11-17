import { route, id } from "@/lib/api";
import { removeSuppression } from "@/lib/service/compliance";
export const DELETE = route<{ id: string }>(async ({ actor, params, url, req }) => removeSuppression(actor, id(params.id), url.searchParams.get("reason") ?? ((await req.json().catch(() => null)) as { reason?: string } | null)?.reason));
