import { route, num } from "@/lib/api";
import { changesSince } from "@/lib/service/agentwork";
export const GET = route(async ({ actor, url }) => changesSince(actor, { since: url.searchParams.get("since"), limit: num(url.searchParams.get("limit")) }));
