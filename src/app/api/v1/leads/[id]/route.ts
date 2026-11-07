import { route, id } from "@/lib/api";
import { getLead, updateLead, setLeadTest } from "@/lib/service/leads";
export const GET = route<{ id: string }>(async ({ actor, params }) => getLead(actor, id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  const b = await body();
  const lid = id(params.id);
  // Owner/Chief only: flag the lead (and its tasks, history, approvals) as test data, or back to real.
  if ("is_test" in b) await setLeadTest(actor, lid, b.is_test === true || b.is_test === "true");
  await updateLead(actor, lid, b);
  return { updated: true };
});
