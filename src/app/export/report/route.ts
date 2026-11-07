import { getSessionActor, HttpError } from "@/lib/auth";
import { reportCsv } from "@/lib/service/csv";
import type { Granularity } from "@/lib/service/reports";

export async function GET(req: Request) {
  const a = await getSessionActor();
  if (!a) return new Response("Unauthorized", { status: 401 });
  const p = new URL(req.url).searchParams;
  const g = (["day", "week", "month"].includes(p.get("g") ?? "") ? p.get("g") : "day") as Granularity;
  try {
    const csv = await reportCsv(a, g, p.get("at") ?? undefined, /^\d+$/.test(p.get("employee") ?? "") ? Number(p.get("employee")) : undefined,
      { all: p.get("all") === "1", from: p.get("from") ?? undefined, to: p.get("to") ?? undefined });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="report-${g}.csv"` } });
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : "Error", { status: e instanceof HttpError ? e.status : 500 });
  }
}
