import { route, num } from "@/lib/api";
import { nextWork } from "@/lib/service/agentwork";
export const GET = route(async ({ actor, url }) => nextWork(actor, { limit: num(url.searchParams.get("limit")), assignee: url.searchParams.get("assignee") === "all" ? "all" : num(url.searchParams.get("assignee")), action: url.searchParams.get("action") }));
