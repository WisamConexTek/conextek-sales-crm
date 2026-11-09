import { route } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { approveSends } from "@/lib/service/sends";
export const POST = route(async ({ actor, body }) => {
  const b = await body();
  if (!Array.isArray(b.items)) throw new HttpError(400, 'items: send {"items":[{"message_version_id":1,"permitted_action":"first_email"}]}.');
  return approveSends(actor, b.items.map((i: Record<string, unknown>) => ({ message_version_id: Number(i.message_version_id), permitted_action: String(i.permitted_action), note: i.note ? String(i.note) : undefined })));
});
