import { route } from "@/lib/api";
import { experimentReport } from "@/lib/service/compliance";
export const GET = route(async ({ actor, url }) => experimentReport(actor, { label: url.searchParams.get("label"), from: url.searchParams.get("from"), to: url.searchParams.get("to"), include_late: url.searchParams.get("include_late") === "1" }));
