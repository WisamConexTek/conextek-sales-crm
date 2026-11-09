import { route } from "@/lib/api";
import { sendDelegationStatus, setSendDelegation } from "@/lib/service/sends";
export const GET = route(async () => sendDelegationStatus());
export const PUT = route(async ({ actor, body }) => {
  const b = await body();
  const id = b.user_id == null || b.user_id === "" ? null : Number(b.user_id);
  await setSendDelegation(actor, id);
  return sendDelegationStatus();
});
