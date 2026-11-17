import Papa from "papaparse";
import { getSessionActor, HttpError } from "@/lib/auth";
import { complianceReport } from "@/lib/service/compliance";

export async function GET(req: Request) {
  const a = await getSessionActor();
  if (!a) return new Response("Unauthorized", { status: 401 });
  try {
    const r = await complianceReport(a, new URL(req.url).searchParams.get("date"));
    const rows = Object.entries(r.sections).flatMap(([section, list]) => (list as Record<string, unknown>[]).map((x) => ({ section: section.replace(/_/g, " "), rule: x.rule, lead_id: x.lead_id, company: x.company, campaign: x.campaign ?? "", sender: x.sender ?? "", step: x.step ?? "", due_on: x.due_on ?? "", window_end_on: x.window_end_on ?? "", days_overdue: x.days_overdue ?? "", state: x.state ?? "", reason: x.reason })));
    return new Response(Papa.unparse(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="compliance-${r.date}.csv"` } });
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : "Error", { status: e instanceof HttpError ? e.status : 500 });
  }
}
