import { route } from "@/lib/api";
import { pendingSendApprovals } from "@/lib/service/sends";
export const GET = route(async ({ actor }) => pendingSendApprovals(actor));
