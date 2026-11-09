import { route } from "@/lib/api";
import { recordBounce } from "@/lib/service/inbound";
export const POST = route(async ({ actor, body }) => recordBounce(actor, await body()));
