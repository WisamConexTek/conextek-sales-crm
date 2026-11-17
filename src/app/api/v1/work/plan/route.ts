import { route, num } from "@/lib/api";
import { workPlan } from "@/lib/service/workplan";
export const GET = route(async ({ actor, url }) => workPlan(actor, { date: url.searchParams.get("date"), role: url.searchParams.get("role"), sender_id: num(url.searchParams.get("sender_id")) }));
