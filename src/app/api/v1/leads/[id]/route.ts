import { route, id } from "@/lib/api";
import { getLead, updateLead, setLeadTest, setLeadHistorical } from "@/lib/service/leads";
export const GET = route<{ id: string }>(async ({ actor, params }) => getLead(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  const b = await body();
  const lid = id(params.id);
  // Owner/Chief only: flag the lead (and its tasks, history, approvals) as test data, or back to real.
  if ("is_test" in b) await setLeadTest(actor, lid, b.is_test === true || b.is_test === "true");
  if ("historical_only" in b) await setLeadHistorical(actor, lid, b.historical_only === true || b.historical_only === "true");
  await updateLead(actor, lid, b);
  return { updated: true };
});
