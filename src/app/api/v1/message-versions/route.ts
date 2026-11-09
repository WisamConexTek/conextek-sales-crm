import { route, num } from "@/lib/api";
import { listVersions } from "@/lib/service/sends";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return listVersions(actor, { campaign_id: num(p.get("campaign_id")), lead_id: num(p.get("lead_id")), sender_id: num(p.get("sender_id")), status: p.get("status") ?? undefined, limit: num(p.get("limit")), page: num(p.get("page")), latest_only: p.get("latest_only") === "1" });
});
