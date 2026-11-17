import { route } from "@/lib/api";
import { complianceReport } from "@/lib/service/compliance";
export const GET = route(async ({ actor, url }) => complianceReport(actor, url.searchParams.get("date")));
