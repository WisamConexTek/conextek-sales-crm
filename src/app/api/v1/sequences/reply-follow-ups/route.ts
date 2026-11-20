import { route, num } from "@/lib/api";
import { replyFollowUps } from "@/lib/service/sequences";
// {dry_run?: true, limit?}. Plans tasks for Interested / Replied leads with nothing planned. Dry run by default.
export const POST = route(async ({ actor, req }) => { const b = ((await req.json().catch(() => ({}))) ?? {}) as { dry_run?: boolean; limit?: unknown }; return replyFollowUps(actor, { dry_run: b.dry_run, limit: num(b.limit == null ? null : String(b.limit)) }); });
