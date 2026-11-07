import { route } from "@/lib/api";
import { importHistory } from "@/lib/service/history";

export const maxDuration = 60;
export const POST = route(async ({ actor, body }) => importHistory(actor, await body()));
