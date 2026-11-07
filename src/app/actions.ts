"use server";
import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { HttpError, login, logout, requireUser, getSessionActor } from "@/lib/auth";
import type { SecretState } from "@/components/SecretAction";
import * as Users from "@/lib/service/users";
import * as Lists from "@/lib/service/lists";
import * as Leads from "@/lib/service/leads";
import * as Tasks from "@/lib/service/tasks";
import { recordActivity } from "@/lib/service/activities";
import { prepareImport, commitImport } from "@/lib/service/csv";
import { seedDemo, removeDemo } from "@/lib/service/demo";
import { ALL_PERMISSIONS, PRESETS } from "@/lib/constants";

type FD = FormData;
const s = (fd: FD, k: string) => String(fd.get(k) ?? "");
const obj = (fd: FD) => Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith("_") && !k.startsWith("$ACTION")));
const n = (fd: FD, k: string) => Number(fd.get(k));

function safeBack(fd: FD, fallback = "/") {
  const b = s(fd, "_back");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
}
const join = (url: string, q: string) => url + (url.includes("?") ? "&" : "?") + q;
const msgOf = (e: unknown) => (e instanceof HttpError ? e.message : (console.error(e), "Something went wrong. Please try again."));

/** Runs a mutation, then redirects back with a success or error banner. */
async function guard(fd: FD, fn: () => Promise<string | void>, fallback = "/") {
  const back = safeBack(fd, fallback);
  let ok: string;
  try {
    ok = (await fn()) || "Saved.";
  } catch (e) {
    unstable_rethrow(e);
    redirect(join(back, "err=" + encodeURIComponent(msgOf(e))));
  }
  revalidatePath("/", "layout");
  redirect(join(back, "ok=" + encodeURIComponent(ok)));
}
async function secret(fn: () => Promise<{ secret: string; message: string }>): Promise<SecretState> {
  try {
    const r = await fn();
    revalidatePath("/", "layout");
    return r;
  } catch (e) {
    unstable_rethrow(e);
    return { error: msgOf(e) };
  }
}

/* ---------- session ---------- */
export async function loginAction(fd: FD) {
  const r = await login(s(fd, "username"), s(fd, "password"));
  if (!r.ok) redirect("/login?err=" + encodeURIComponent(r.error));
  redirect("/");
}
export async function logoutAction() {
  await logout();
  redirect("/login");
}
export async function changePasswordAction(fd: FD) {
  const a = await requireUser({ allowPasswordChange: true });
  const back = "/account";
  try {
    if (s(fd, "next") !== s(fd, "confirm")) throw new HttpError(400, "New passwords don't match.");
    await Users.changeOwnPassword(a, s(fd, "current"), s(fd, "next"));
  } catch (e) {
    unstable_rethrow(e);
    redirect(join(back, "err=" + encodeURIComponent(msgOf(e))));
  }
  // Password change invalidates the old session: sign in again.
  await logout();
  redirect("/login?ok=" + encodeURIComponent("Password changed. Please sign in again."));
}
export async function toggleDemoAction(fd: FD) {
  const c = await cookies();
  if (c.get("crm_demo")?.value === "1") c.delete("crm_demo");
  else c.set("crm_demo", "1", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 86400 * 30 });
  redirect(safeBack(fd));
}

/* ---------- leads ---------- */
export async function createLeadAction(fd: FD) {
  const a = await requireUser();
  const data: Record<string, unknown> = obj(fd);
  const contactName = s(fd, "contact_name");
  data.contacts = contactName
    ? [{ name: contactName, role: s(fd, "contact_role"), email: s(fd, "contact_email"), phone: s(fd, "contact_phone"), linkedin: s(fd, "contact_linkedin"), other_social: s(fd, "contact_other_social") }]
    : [];
  let id = 0;
  try {
    id = await Leads.createLead(a, data);
  } catch (e) {
    unstable_rethrow(e);
    const dups = (e as { duplicates?: { id: number }[] }).duplicates;
    redirect(join("/leads/new", "err=" + encodeURIComponent(msgOf(e)) + (dups ? "&dup=1" : "")));
  }
  revalidatePath("/", "layout");
  redirect(`/leads/${id}?ok=${encodeURIComponent("Lead created.")}`);
}
export async function updateLeadAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Leads.updateLead(a, n(fd, "id"), obj(fd)); return "Lead updated."; });
}
export async function setStageAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Leads.setStage(a, n(fd, "id"), s(fd, "stage"), s(fd, "reason")); return "Stage recorded."; });
}
export async function addContactAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Leads.addContact(a, n(fd, "lead_id"), obj(fd)); return "Contact added."; });
}
export async function updateContactAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Leads.updateContact(a, n(fd, "id"), obj(fd)); return "Contact updated."; });
}
export async function recordActivityAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const r = await recordActivity(a, n(fd, "lead_id"), obj(fd));
    return "Recorded." + (r.warnings.length ? " Warning: " + r.warnings.join(" ") : "");
  });
}

/* ---------- tasks & approvals ---------- */
export async function createTaskAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Tasks.createTask(a, obj(fd)); return "Task created."; });
}
export async function updateTaskAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Tasks.updateTask(a, n(fd, "id"), obj(fd)); return "Task updated."; });
}
export async function submitTaskAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Tasks.submitTask(a, n(fd, "id"), obj(fd)); return "Submitted for approval."; });
}
export async function completeTaskAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Tasks.completeTask(a, n(fd, "id"), s(fd, "note")); return "Task marked complete."; });
}
export async function decideApprovalAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    await Tasks.decideApproval(a, n(fd, "id"), { decision: s(fd, "decision"), comment: s(fd, "comment") });
    return "Decision recorded.";
  }, "/approvals");
}
export async function escalateApprovalAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Tasks.escalateApproval(a, n(fd, "id"), s(fd, "comment")); return "Escalated to Wisam."; }, "/approvals");
}

/* ---------- settings ---------- */
export async function createUserAction(_p: SecretState, fd: FD): Promise<SecretState> {
  const a = await requireUser();
  return secret(async () => {
    const r = await Users.createUser(a, obj(fd));
    return { secret: r.tempPassword, message: `Account "${s(fd, "username")}" created. Temporary password:` };
  });
}
export async function resetPasswordAction(_p: SecretState, fd: FD): Promise<SecretState> {
  const a = await requireUser();
  return secret(async () => ({ secret: await Users.resetPassword(a, n(fd, "id")), message: "Temporary password set (they must change it at next login)." }));
}
export async function createKeyAction(_p: SecretState, fd: FD): Promise<SecretState> {
  const a = await requireUser();
  return secret(async () => ({ secret: await Users.createKey(a, n(fd, "user_id"), s(fd, "label")), message: "API key created." }));
}
export async function updateUserAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    await Users.updateUserProfile(a, n(fd, "id"), { name: s(fd, "name"), role: s(fd, "role"), active: s(fd, "active") === "1" });
    return "Account updated.";
  });
}
export async function setPermsAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const perms = ALL_PERMISSIONS.filter((p) => fd.get("perm:" + p) === "on");
    await Users.setPermissions(a, n(fd, "id"), perms, "custom");
    return "Permissions saved.";
  });
}
export async function applyPresetAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const p = PRESETS[s(fd, "preset")];
    if (!p) throw new HttpError(400, "Unknown preset.");
    await Users.setPermissions(a, n(fd, "id"), p.perms, s(fd, "preset"));
    return `Preset "${p.label}" applied.`;
  });
}
export async function keyToggleAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Users.setKeyActive(a, n(fd, "id"), s(fd, "active") === "1"); return "Key updated."; });
}
export async function keyRevokeAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Users.revokeKey(a, n(fd, "id")); return "Key revoked."; });
}
export async function addListItemAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Lists.addItem(a, s(fd, "kind"), s(fd, "label"), s(fd, "flag") || null); return "Added."; });
}
export async function updateListItemAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    await Lists.updateItem(a, n(fd, "id"), { label: s(fd, "label"), flag: s(fd, "flag") || null, active: s(fd, "active") === "1" });
    return "Saved.";
  });
}
export async function moveListItemAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Lists.move(a, n(fd, "id"), n(fd, "dir") < 0 ? -1 : 1); });
}

/* ---------- CSV import (two steps; returns data for the client component) ---------- */
export type ImportState =
  | { step: "preview"; rows: Awaited<ReturnType<typeof prepareImport>>["rows"]; unknownColumns: string[]; text: string }
  | { step: "done"; created: number; skipped: number; failed: number; errors: string[] }
  | { step: "error"; error: string }
  | null;

export async function importAction(_p: ImportState, fd: FD): Promise<ImportState> {
  const a = await getSessionActor();
  if (!a) return { step: "error", error: "Please sign in again." };
  try {
    const text = s(fd, "text");
    if (s(fd, "mode") === "commit") {
      const r = await commitImport(a, text, s(fd, "dups") === "on");
      revalidatePath("/", "layout");
      return { step: "done", ...r };
    }
    const r = await prepareImport(a, text);
    return { step: "preview", ...r, text };
  } catch (e) {
    unstable_rethrow(e);
    return { step: "error", error: msgOf(e) };
  }
}

export async function loadDemoAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await seedDemo(a); return "Demo data loaded. Use the sidebar toggle to show it. It is excluded from all reports."; }, "/settings");
}
export async function removeDemoAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await removeDemo(a); return "Demo data removed."; }, "/settings");
}
