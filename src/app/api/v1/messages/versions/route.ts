import { route } from "@/lib/api";
import { createVersion, getVersion } from "@/lib/service/sends";
export const POST = route(async ({ actor, body }) => { const r = await createVersion(actor, await body()); return { ...r, version_detail: await getVersion(actor, r.id) }; });
