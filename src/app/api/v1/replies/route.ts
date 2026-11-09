import { route } from "@/lib/api";
import { recordReply } from "@/lib/service/inbound";
export const POST = route(async ({ actor, body }) => recordReply(actor, await body()));
