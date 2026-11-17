import { route, num } from "@/lib/api";
import { HttpError, isManager } from "@/lib/auth";
import { sequenceLog } from "@/lib/service/sequences";
export const GET = route(async ({ actor, url }) => {
  if (!isManager(actor) && !actor.perms.has("compliance.view")) throw new HttpError(403, "Only the Owner, a Chief or the compliance monitor can read this log.");
  return sequenceLog(num(url.searchParams.get("limit")) ?? 100);
});
