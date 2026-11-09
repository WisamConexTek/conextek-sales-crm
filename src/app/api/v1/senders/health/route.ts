import { route } from "@/lib/api";
import { sendersHealth } from "@/lib/service/senders";
export const GET = route(async () => sendersHealth());
