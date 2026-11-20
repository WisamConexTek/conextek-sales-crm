import { route, id } from "@/lib/api";
import { getLead, updateLead, setLeadTest, setLeadHistorical, leadListExtras, nextStepOf } from "@/lib/service/leads";
import { leadSequenceInfo } from "@/lib/service/sequences";
// next_step is computed from the open tasks and the sequence. The lead's own next_action text is an old free-text note and is not a task.
export const GET = route<{ id: string }>(async ({ actor, params }) => {
  const r = await getLead(actor, id(params.id));
  const [ex, seq] = await Promise.all([leadListExtras([r.lead.id as number]), leadSequenceInfo([r.lead.id as number])]);
  return { ...r, next_step: nextStepOf(ex.nextTask.get(r.lead.id as number), seq.get(r.lead.id as number)) };
});
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  const b = await body();
  const lid = id(params.id);
  // Owner/Chief only: flag the lead (and its tasks, history, approvals) as test data, or back to real.
  if ("is_test" in b) await setLeadTest(actor, lid, b.is_test === true || b.is_test === "true");
  if ("historical_only" in b) await setLeadHistorical(actor, lid, b.historical_only === true || b.historical_only === "true");
  await updateLead(actor, lid, b);
  return { updated: true };
});
