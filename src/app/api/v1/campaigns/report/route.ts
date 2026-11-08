import { route, num } from "@/lib/api";
import { campaignReport } from "@/lib/service/schedule";
export const GET = route(async ({ actor, url }) => campaignReport(actor, num(url.searchParams.get("campaign_id"))));
