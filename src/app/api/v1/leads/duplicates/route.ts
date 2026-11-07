import { route } from "@/lib/api";
import { findDuplicates } from "@/lib/service/leads";
export const GET = route(async ({ url }) => {
  const p = url.searchParams;
  return findDuplicates({ company: p.get("company"), website: p.get("website"), emails: p.getAll("email") });
});
