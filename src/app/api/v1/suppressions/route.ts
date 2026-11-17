import { route, num } from "@/lib/api";
import { listSuppressions } from "@/lib/service/compliance";
export const GET = route(async ({ actor, url }) => listSuppressions(actor, { kind: url.searchParams.get("kind"), q: url.searchParams.get("q"), limit: num(url.searchParams.get("limit")) }));
