import { getSessionActor, HttpError } from "@/lib/auth";
import { leadsCsv } from "@/lib/service/csv";

export async function GET(req: Request) {
  const a = await getSessionActor();
  if (!a) return new Response("Unauthorized", { status: 401 });
  const p = new URL(req.url).searchParams;
  const num = (k: string) => (/^\d+$/.test(p.get(k) ?? "") ? Number(p.get(k)) : undefined);
  try {
    const csv = await leadsCsv(a, { q: p.get("q") ?? undefined, owner: num("owner"), market: p.get("market") ?? undefined, segment: p.get("segment") ?? undefined, stage: p.get("stage") ?? undefined, channel: p.get("channel") ?? undefined });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"` } });
  } catch (e) {
    return new Response(e instanceof HttpError ? e.message : "Error", { status: e instanceof HttpError ? e.status : 500 });
  }
}
