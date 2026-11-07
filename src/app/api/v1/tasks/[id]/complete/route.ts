import { route, id } from "@/lib/api";
import { completeTask } from "@/lib/service/tasks";
export const POST = route<{ id: string }>(async ({ actor, params, req }) => {
  const b = await req.json().catch(() => ({}));
  await completeTask(actor, id(params.id), typeof b?.note === "string" ? b.note : null);
  return { completed: true };
});
