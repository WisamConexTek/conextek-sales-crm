import { route } from "@/lib/api";
import { seqSettings, setSeqSettings, roleUsers } from "@/lib/service/sequences";
export const GET = route(async () => { const s = await seqSettings(); return { ...s, role_users: await roleUsers(s) }; });
export const PATCH = route(async ({ actor, body }) => setSeqSettings(actor, await body()));
