import { route } from "@/lib/api";
import { authorize } from "@/lib/service/sends";
export const POST = route(async ({ actor, body }) => authorize(actor, await body()));
