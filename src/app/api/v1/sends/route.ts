import { route } from "@/lib/api";
import { confirmSend, listSends } from "@/lib/service/sends";
export const GET = route(async ({ actor, url }) => listSends(actor, url.searchParams.get("status") ?? undefined));
export const POST = route(async ({ actor, body }) => confirmSend(actor, await body()));
