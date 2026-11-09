import { route } from "@/lib/api";
import { reconcileTasks } from "@/lib/service/sends";
export const POST = route(async ({ actor }) => reconcileTasks(actor));
