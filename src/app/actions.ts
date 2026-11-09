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
import * as Campaigns from "@/lib/service/campaigns";
import * as Sends from "@/lib/service/sends";
import { recordActivity } from "@/lib/service/activities";
import { prepareImport, commitImport } from "@/lib/service/csv";
import { correctLeadDates, type DateFixRow } from "@/lib/service/history";
import Papa from "papaparse";
import { fmtDateTime } from "@/lib/format";
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
  if (c.get("crm_hide_test")?.value === "1") c.delete("crm_hide_test");
  else c.set("crm_hide_test", "1", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 86400 * 30 });
  redirect(safeBack(fd));
}
export async function setLeadTestAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const on = s(fd, "is_test") === "1";
    await Leads.setLeadTest(a, n(fd, "id"), on);
    return on ? "Marked as test data. It is now excluded from dashboard and report totals." : "Marked as real data. It now counts in dashboard and reports.";
  });
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
  await guard(fd, async () => {
    const actRaw = fd.get("activity_id");
    const actId = actRaw && /^\d+$/.test(String(actRaw)) ? Number(actRaw) : undefined;
    await Tasks.completeTask(a, n(fd, "id"), { note: s(fd, "note"), activity_id: actId });
    return "Task marked complete.";
  });
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
    return { secret: r.password, message: `Account "${s(fd, "username")}" created. Password:` };
  });
}
export async function resetPasswordAction(_p: SecretState, fd: FD): Promise<SecretState> {
  const a = await requireUser();
  return secret(async () => ({ secret: await Users.resetPassword(a, n(fd, "id"), s(fd, "password")), message: "Password set. Existing sessions were signed out." }));
}
export async function createKeyAction(_p: SecretState, fd: FD): Promise<SecretState> {
  const a = await requireUser();
  return secret(async () => ({ secret: await Users.createKey(a, n(fd, "user_id"), s(fd, "label")), message: "API key created." }));
}
export async function setMigrationAccessAction(fd: FD) {
  const a = await requireUser();
  const h = s(fd, "hours");
  await guard(fd, async () => {
    const until = await Users.setMigrationAccess(a, n(fd, "id"), h === "revoke" ? null : Number(h));
    return until ? "Migration access granted until " + fmtDateTime(until) + "." : "Migration access revoked.";
  });
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

/* ---------- bulk correction of original lead dates (CSV: id | external_id | website | company, lead_date, optional employee) ---------- */
export type DateFixState =
  | { step: "preview"; rows: DateFixRow[]; counts: Record<string, number>; text: string }
  | { step: "done"; rows: DateFixRow[]; counts: Record<string, number> }
  | { step: "error"; error: string }
  | null;
export async function dateFixAction(_p: DateFixState, fd: FD): Promise<DateFixState> {
  const a = await getSessionActor();
  if (!a) return { step: "error", error: "Please sign in again." };
  try {
    const text = s(fd, "text");
    const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: norm });
    if (!parsed.meta.fields?.length) return { step: "error", error: "The file has no header row." };
    const f = new Set(parsed.meta.fields);
    if (!f.has("lead_date")) return { step: "error", error: 'No "lead_date" column. Needed: lead_date plus one of id, external_id, website or company.' };
    if (!["id", "lead_id", "external_id", "website", "company"].some((c) => f.has(c))) return { step: "error", error: "No column to find the lead by: add id, external_id, website or company." };
    const records = parsed.data.map((r) => ({ id: r.id || r.lead_id || undefined, external_id: r.external_id, website: r.website, company: r.company, lead_date: r.lead_date, employee: r.employee }));
    const commit = s(fd, "mode") === "commit";
    const r = await correctLeadDates(a, { records, commit, label: s(fd, "label") || "Lead date correction (CSV)" });
    if (commit) revalidatePath("/", "layout");
    return commit ? { step: "done", rows: r.results, counts: r.counts } : { step: "preview", rows: r.results, counts: r.counts, text };
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
  if (s(fd, "confirm").trim().toUpperCase() !== "DELETE") redirect(join(safeBack(fd), "err=" + encodeURIComponent("Type DELETE to confirm — removing test data is permanent.")));
  const a = await requireUser();
  await guard(fd, async () => { await removeDemo(a); return "Demo data removed."; }, "/settings");
}

export async function createCampaignAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Campaigns.createCampaign(a, obj(fd)); return "Campaign created."; }, "/campaigns");
}
export async function setCampaignStatusAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => { await Campaigns.updateCampaign(a, n(fd, "id"), { status: s(fd, "status") }); return "Campaign updated."; }, "/campaigns");
}
export async function enrolLeadAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const from = s(fd, "transfer_from_campaign_id");
    const r = await Campaigns.enrolLead(a, n(fd, "lead_id"), { campaign_id: n(fd, "campaign_id"), ...(from ? { transfer_from_campaign_id: Number(from) } : {}), note: s(fd, "note") });
    return r.changed ? (from ? "Lead transferred. History kept." : "Lead added to the campaign.") : "Already in that campaign.";
  }, "/campaigns");
}

export async function approveSendsAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const only = s(fd, "only");
    const ids = only ? [Number(only)] : fd.getAll("v").map(Number);
    const r = await Sends.approveSends(a, ids.map((id) => ({ message_version_id: id, permitted_action: s(fd, `action_${id}`) || "first_email" })));
    const bad = r.results.filter((x) => x.status === "error");
    if (bad.length && !r.approved) throw new HttpError(409, bad.map((b) => `#${b.message_version_id}: ${b.error}`).join(" | "));
    return `Send approved for ${r.approved} message${r.approved === 1 ? "" : "s"}.${bad.length ? ` ${bad.length} failed: ${bad.map((b) => `#${b.message_version_id} ${b.error}`).join(" | ")}` : ""}`;
  }, "/send-approvals");
}
export async function rejectDraftAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    await Sends.rejectVersion(a, Number(s(fd, "id")), s(fd, "reason"));
    return "Draft rejected. The reason is saved for the agents.";
  }, "/send-approvals");
}
export async function editDraftAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const r = await Sends.editVersion(a, Number(s(fd, "id")), { subject: s(fd, "subject"), body: s(fd, "body"), note: s(fd, "note") });
    return `Saved as version #${r.new_version_id}. It still needs your send approval below.`;
  }, "/send-approvals");
}
export async function setSendDelegationAction(fd: FD) {
  const a = await requireUser();
  await guard(fd, async () => {
    const uid = s(fd, "user_id");
    await Sends.setSendDelegation(a, uid ? Number(uid) : null);
    return uid ? "Send approval delegated." : "Delegation turned off.";
  }, "/send-approvals");
}
