import { route, num } from "@/lib/api";
import { listRequests } from "@/lib/service/agents";
/** The API request log. Owner/Chief: everyone's calls; anyone else: their own. */
export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return listRequests(actor, { actor: num(p.get("actor")), outcome: p.get("outcome") ?? undefined, kind: p.get("kind") ?? undefined, run: p.get("run_id") ?? undefined, lead: num(p.get("lead_id")), task: num(p.get("task_id")),
    q: p.get("q") ?? undefined, from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, page: num(p.get("page")), pageSize: num(p.get("page_size")) });
});
