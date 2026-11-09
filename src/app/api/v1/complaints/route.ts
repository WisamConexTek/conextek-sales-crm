import { route } from "@/lib/api";
import { recordComplaint } from "@/lib/service/senders";
import { assertLeadAccess } from "@/lib/service/leads";
export const POST = route(async ({ actor, body }) => recordComplaint(actor, await body(), assertLeadAccess));
