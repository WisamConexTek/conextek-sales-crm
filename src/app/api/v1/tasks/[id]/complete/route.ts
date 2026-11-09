import { route, id } from "@/lib/api";
import { completeTask } from "@/lib/service/tasks";

export const POST = route<{ id: string }>(async ({ actor, params, req }) => {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const note = typeof b?.note === "string" ? b.note : null;
  const activity_id =
    b?.activity_id !== undefined && b?.activity_id !== null
      ? (b.activity_id as number)
      : undefined;
  await completeTask(actor, id(params.id), { note, activity_id });
  return { completed: true };
});
