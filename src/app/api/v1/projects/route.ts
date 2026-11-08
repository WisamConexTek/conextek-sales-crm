import { route } from "@/lib/api";
import { listProjects } from "@/lib/service/campaigns";
export const GET = route(async () => listProjects());
