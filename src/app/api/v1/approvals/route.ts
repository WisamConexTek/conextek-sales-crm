import { route } from "@/lib/api";
import { listApprovals } from "@/lib/service/tasks";
export const GET = route(async ({ actor, url }) => listApprovals(actor, { status: url.searchParams.get("status") ?? undefined, requires: url.searchParams.get("requires") ?? undefined, includeDemo: url.searchParams.get("include_test") !== "0" }));
