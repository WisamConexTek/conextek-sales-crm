import { route, num } from "@/lib/api";
import { listLeads, createLead, ATTENTION, type Attention } from "@/lib/service/leads";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return listLeads(actor, {
    q: p.get("q") ?? undefined, owner: num(p.get("owner")), market: p.get("market") ?? undefined, segment: p.get("segment") ?? undefined, includeDemo: p.get("include_test") !== "0", includeHistorical: p.get("include_historical") !== "0",
    campaign: num(p.get("campaign_id")), attention: (ATTENTION as readonly string[]).includes(p.get("attention") ?? "") ? (p.get("attention") as Attention) : undefined,
    stage: p.get("stage") ?? undefined, channel: p.get("channel") ?? undefined, page: num(p.get("page")), pageSize: Math.min(num(p.get("page_size")) ?? 50, 200),
  });
});
export const POST = route(async ({ actor, body }) => ({ id: await createLead(actor, await body()) }));
