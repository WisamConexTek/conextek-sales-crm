import { getSessionActor, HttpError } from "@/lib/auth";
import { leadsCsv } from "@/lib/service/csv";
import { leadFiltersFrom } from "@/lib/service/leads";

export async function GET(req: Request) {
  const a = await getSessionActor();
  if (!a) return new Response("Unauthorized", { status: 401 });
  const p = new URL(req.url).searchParams;
  try {
    const csv = await leadsCsv(a, { ...leadFiltersFrom((k) => p.get(k)), includeHistorical: p.get("hide_hist") === "1" ? false : undefined });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"` } });
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : "Error", { status: e instanceof HttpError ? e.status : 500 });
  }
}
