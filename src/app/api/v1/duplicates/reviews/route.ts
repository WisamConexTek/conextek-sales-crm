import { route } from "@/lib/api";
import { requestReview, listReviews } from "@/lib/service/dedupe";
export const GET = route(async ({ actor, url }) => listReviews(actor, url.searchParams.get("status") ?? "pending"));
export const POST = route(async ({ actor, body }) => requestReview(actor, await body()));
