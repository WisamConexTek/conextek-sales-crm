import { route } from "@/lib/api";
import { listCampaigns, createCampaign, getCampaign } from "@/lib/service/campaigns";
export const GET = route(async () => listCampaigns());
export const POST = route(async ({ actor, body }) => getCampaign(await createCampaign(actor, await body())));
