import { route, id } from "@/lib/api";
import { getCampaign, updateCampaign } from "@/lib/service/campaigns";
export const GET = route<{ id: string }>(async ({ params }) => getCampaign(id(params.id)));
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => {
  await updateCampaign(actor, id(params.id), await body());
  return getCampaign(id(params.id));
});
