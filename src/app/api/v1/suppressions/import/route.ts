import { route } from "@/lib/api";
import { importSuppressions } from "@/lib/service/compliance";
export const POST = route(async ({ actor, body }) => importSuppressions(actor, await body()));
