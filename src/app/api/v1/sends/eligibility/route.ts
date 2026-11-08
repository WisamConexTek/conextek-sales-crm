import { route, num } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { checkEligibility } from "@/lib/service/sends";
export const GET = route(async ({ actor, url }) => {
  const v = num(url.searchParams.get("message_version_id"));
  if (!v) throw new HttpError(400, "message_version_id is required.");
  return checkEligibility(actor, v);
});
