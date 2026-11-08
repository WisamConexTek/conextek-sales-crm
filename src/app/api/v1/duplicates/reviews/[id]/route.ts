import { route, id } from "@/lib/api";
import { decideReview } from "@/lib/service/dedupe";
export const PATCH = route<{ id: string }>(async ({ actor, params, body }) => { await decideReview(actor, id(params.id), await body()); return { decided: true }; });
