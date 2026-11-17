import { route } from "@/lib/api";
import { taskSummary, assertAssignee } from "@/lib/service/tasklist";
export const GET = route(async ({ actor, url }) => taskSummary(actor, { assignee: assertAssignee(actor, url.searchParams.get("assignee")), includeTest: url.searchParams.get("include_test") === "1" }));
