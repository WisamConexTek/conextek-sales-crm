import { route } from "@/lib/api";
import { correctLeadDates } from "@/lib/service/history";

export const maxDuration = 60;
export const POST = route(async ({ actor, body }) => correctLeadDates(actor, await body()));
