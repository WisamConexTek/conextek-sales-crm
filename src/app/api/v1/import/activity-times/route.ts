import { route } from "@/lib/api";
import { correctActivityTimes } from "@/lib/service/history";

export const maxDuration = 60;
export const POST = route(async ({ actor, body }) => correctActivityTimes(actor, await body()));
