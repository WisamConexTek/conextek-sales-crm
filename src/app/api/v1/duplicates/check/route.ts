import { route } from "@/lib/api";
import { checkIdentity } from "@/lib/service/dedupe";
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
export const POST = route(async ({ actor, body }) => {
  const b = await body();
  const { decision, matches } = await checkIdentity(actor, { company: b.company as string, website: b.website as string, emails: list(b.emails ?? b.email), phones: list(b.phones ?? b.phone), profiles: list(b.profiles ?? b.profile) });
  return { decision, matches };
});
