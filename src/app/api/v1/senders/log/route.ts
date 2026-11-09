import { route, num } from "@/lib/api";
import { senderLog } from "@/lib/service/senders";
export const GET = route(async ({ actor, url }) => senderLog(actor, num(url.searchParams.get("sender_id"))));
