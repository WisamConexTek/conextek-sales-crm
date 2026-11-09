import { route } from "@/lib/api";
import { listDecisions } from "@/lib/service/sends";
export const GET = route(async ({ actor, url }) => listDecisions(actor, { lead_id: url.searchParams.get("lead_id") ? Number(url.searchParams.get("lead_id")) : undefined, limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined }));
