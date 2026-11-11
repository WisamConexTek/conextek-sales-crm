import { route } from "@/lib/api";
import { ALL_PERMISSIONS } from "@/lib/constants";
import { can } from "@/lib/auth";
import { GUIDE_VERSION } from "@/lib/agent-guide";
export const GET = route(async ({ actor }) => ({
  id: actor.id, username: actor.username, name: actor.name, role: actor.role, is_agent: !!actor.isAgent, key_label: actor.keyLabel ?? null,
  permissions: ALL_PERMISSIONS.filter((p) => can(actor, p)),
  guide_version: GUIDE_VERSION, run_id: actor.runId ?? null,
  note: "Nothing in this CRM sends messages. Record work only after it has really happened. Send the header X-Run-Id: <one id per run> on every call so the Owner can follow your run step by step.",
}));
