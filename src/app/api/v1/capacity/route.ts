import { route } from "@/lib/api";
import { capacityFor } from "@/lib/service/capacity";
export const GET = route(async ({ url }) => capacityFor(url.searchParams.get("date") ?? undefined));
