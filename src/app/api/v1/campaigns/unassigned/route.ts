import { route, num } from "@/lib/api";
import { unassignedLeads } from "@/lib/service/campaigns";
export const GET = route(async ({ actor, url }) => unassignedLeads(actor, num(url.searchParams.get("page")) ?? 1, Math.min(num(url.searchParams.get("page_size")) ?? 100, 500)));
