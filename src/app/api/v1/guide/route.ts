import { route } from "@/lib/api";
import { AGENT_GUIDE, GUIDE_VERSION } from "@/lib/agent-guide";
export const GET = route(async () => ({ version: GUIDE_VERSION, format: "markdown", guide: AGENT_GUIDE }));
