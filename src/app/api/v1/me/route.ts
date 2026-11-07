import { route } from "@/lib/api";
import { ALL_PERMISSIONS } from "@/lib/constants";
import { can } from "@/lib/auth";
export const GET = route(async ({ actor }) => ({
  id: actor.id, username: actor.username, name: actor.name, role: actor.role,
  permissions: ALL_PERMISSIONS.filter((p) => can(actor, p)),
  note: "Nothing in this CRM sends messages. Record work only after it has really happened.",
}));
