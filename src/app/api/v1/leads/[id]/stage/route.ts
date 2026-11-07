import { route, id } from "@/lib/api";
import { setStage } from "@/lib/service/leads";
export const POST = route<{ id: string }>(async ({ actor, params, body }) => {
  const b = await body();
  await setStage(actor, id(params.id), String(b.stage ?? ""), String(b.reason ?? ""));
  return { updated: true };
});
