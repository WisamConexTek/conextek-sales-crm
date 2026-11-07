import { route } from "@/lib/api";
import { reconcileActivities } from "@/lib/service/history";

export const maxDuration = 60;
export const POST = route(async ({ actor, body }) => reconcileActivities(actor, await body()));
