import { route, num } from "@/lib/api";
import { listLeads, createLead, leadFiltersFrom } from "@/lib/service/leads";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return listLeads(actor, { ...leadFiltersFrom((k) => p.get(k)), includeDemo: p.get("include_test") !== "0", includeHistorical: p.get("include_historical") !== "0", page: num(p.get("page")), pageSize: Math.min(num(p.get("page_size")) ?? 50, 200) });
});
export const POST = route(async ({ actor, body }) => ({ id: await createLead(actor, await body()) }));
