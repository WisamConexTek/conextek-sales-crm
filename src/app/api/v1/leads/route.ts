import { route, num } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { listLeads, createLead, leadFiltersFrom, withNextStep } from "@/lib/service/leads";
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  const r = await listLeads(actor, { ...leadFiltersFrom((k) => p.get(k)), includeDemo: p.get("include_test") !== "0", includeHistorical: p.get("include_historical") !== "0", page: num(p.get("page")), pageSize: Math.min(num(p.get("page_size")) ?? 50, 200) });
  // A filter or sort value that was not understood is reported in warnings[]; with strict=1 it is refused instead.
  if (p.get("strict") === "1" && r.warnings.length) throw new HttpError(400, r.warnings.join(" "), "invalid_filter");
  return { ...r, rows: await withNextStep(r.rows) };
});
export const POST = route(async ({ actor, body }) => ({ id: await createLead(actor, await body()) }));
