import { route, id, num } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { assertLeadAccess } from "@/lib/service/leads";
import { leadCampaigns, enrolLead, removeFromCampaign } from "@/lib/service/campaigns";
export const GET = route<{ id: string }>(async ({ actor, params }) => {
  await assertLeadAccess(actor, id(params.id));
  return leadCampaigns(id(params.id));
});
export const POST = route<{ id: string }>(async ({ actor, params, body }) => {
  await enrolLead(actor, id(params.id), await body());
  return leadCampaigns(id(params.id));
});
export const DELETE = route<{ id: string }>(async ({ actor, params, url }) => {
  const c = num(url.searchParams.get("campaign_id"));
  if (!c) throw new HttpError(400, "campaign_id query parameter is required.");
  await removeFromCampaign(actor, id(params.id), c);
  return leadCampaigns(id(params.id));
});
