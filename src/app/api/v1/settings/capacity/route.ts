import { route } from "@/lib/api";
import { capacitySettings, setCapacitySettings } from "@/lib/service/capacity";
export const GET = route(async () => capacitySettings());
export const PUT = route(async ({ actor, body }) => setCapacitySettings(actor, await body()));
