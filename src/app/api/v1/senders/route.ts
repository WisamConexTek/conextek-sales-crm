import { route } from "@/lib/api";
import { listSenders, createSender } from "@/lib/service/senders";
export const GET = route(async () => listSenders());
export const POST = route(async ({ actor, body }) => createSender(actor, await body()));
