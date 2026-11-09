import { route } from "@/lib/api";
import { reportApi } from "@/lib/service/reports";
import type { Granularity } from "@/lib/service/reports";

export const GET = route(async ({ actor, url }) => {
  const p = url.searchParams;
  return reportApi(actor, {
    all: p.get("all") === "1", from: p.get("from") ?? undefined, to: p.get("to") ?? undefined,
    period: (p.get("period") ?? undefined) as Granularity | undefined, at: p.get("at") ?? undefined, employee: p.get("employee"), sender: p.get("sender"),
  });
});
