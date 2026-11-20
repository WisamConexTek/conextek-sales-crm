import { route } from "@/lib/api";
import { revokeBlockedApprovals } from "@/lib/service/sends";
// {dry_run?: true}. Withdraws active SEND approvals whose recipient opted out, is suppressed, bounced, or replied (sequence follow-ups). Dry run by default.
export const POST = route(async ({ actor, req }) => revokeBlockedApprovals(actor, ((await req.json().catch(() => ({}))) ?? {}) as { dry_run?: boolean }));
