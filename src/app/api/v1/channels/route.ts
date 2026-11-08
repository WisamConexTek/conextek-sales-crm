import { route } from "@/lib/api";
import { listChannels } from "@/lib/service/campaigns";
export const GET = route(async () => listChannels());
