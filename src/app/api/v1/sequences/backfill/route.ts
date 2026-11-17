import { route } from "@/lib/api";
import { backfill } from "@/lib/service/sequences";
// dry_run defaults to true: the list of what would be planned, and nothing is created.
export const POST = route(async ({ actor, body }) => backfill(actor, await body()));
