import { route, num } from "@/lib/api";
import { recordReply, listReplies } from "@/lib/service/inbound";
export const GET = route(async ({ actor, url }) => listReplies(actor, { lead_id: num(url.searchParams.get("lead_id")), from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, limit: num(url.searchParams.get("limit")) }));
export const POST = route(async ({ actor, body }) => recordReply(actor, await body()));
