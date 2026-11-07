import { route } from "@/lib/api";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
export const GET = route(async () => {
  const lists = await getLists();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(lists)) out[k] = v.map((i) => ({ key: i.key, label: i.label, flag: i.flag }));
  out.task_status = ["todo", "in_progress", "waiting_approval", "changes_requested", "approved", "completed", "cancelled"];
  out.activity_outcome = ["sent", "reply_received", "bounced", "no_response_yet", "opted_out"];
  out.users = await assignableUsers();
  return out;
});
