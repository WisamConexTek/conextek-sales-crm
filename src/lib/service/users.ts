import { z } from "zod";
import { all, one, run, now, type Row } from "../db";
import {
  HttpError, type Actor, hashPassword, validatePassword, generateTempPassword, newApiKey, can,
} from "../auth";
import { ALL_PERMISSIONS, PRESETS, type Permission } from "../constants";
import { audit, parse, reqText } from "./common";
import bcrypt from "bcryptjs";

const safeCols = "id,username,name,role,preset,permissions,must_change_password,active,last_login_at,created_at";

export async function listUsers(includeInactive = true): Promise<Row[]> {
  const rows = await all(`SELECT ${safeCols} FROM users ${includeInactive ? "" : "WHERE active=1"} ORDER BY active DESC, role, name`);
  return rows.map((r) => ({ ...r, perms: JSON.parse(r.permissions) as Permission[] }));
}
export async function getUser(id: number): Promise<Row | null> {
  const r = await one(`SELECT ${safeCols} FROM users WHERE id=?`, [id]);
  return r ? { ...r, perms: JSON.parse(r.permissions) as Permission[] } : null;
}
/** Active people that can be assigned work. */
export async function assignableUsers(): Promise<Row[]> {
  return all("SELECT id,name,username,role FROM users WHERE active=1 ORDER BY name");
}

const createSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/, "letters, numbers, . _ - only"),
  name: reqText(80),
  role: z.enum(["chief", "employee"]),
  preset: z.string().optional(),
});

export async function createUser(actor: Actor, input: unknown) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner can add team members.");
  const d = parse(createSchema, input);
  if (await one("SELECT id FROM users WHERE username=?", [d.username])) throw new HttpError(409, "That username already exists.");
  const presetKey = d.preset && PRESETS[d.preset] ? d.preset : d.role === "chief" ? "chief" : "researcher";
  const preset = PRESETS[presetKey];
  const temp = generateTempPassword();
  const t = now();
  const r = await run(
    `INSERT INTO users (username,name,role,preset,permissions,password_hash,must_change_password,created_at,updated_at)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    [d.username, d.name, d.role, presetKey, JSON.stringify(preset.perms), await hashPassword(temp), t, t],
  );
  await audit(actor, "create_user", "user", r.id, { username: d.username, role: d.role, preset: presetKey });
  return { id: r.id, tempPassword: temp };
}

export async function updateUserProfile(actor: Actor, id: number, input: { name?: string; role?: string; active?: boolean }) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner can edit accounts.");
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "User not found.");
  if (u.role === "owner") {
    if (input.active === false || (input.role && input.role !== "owner")) throw new HttpError(400, "The owner account cannot be disabled or demoted.");
  }
  if (id === actor.id && input.active === false) throw new HttpError(400, "You cannot disable your own account.");
  const name = input.name?.trim() || u.name;
  const role = u.role === "owner" ? "owner" : input.role === "chief" || input.role === "employee" ? input.role : u.role;
  const active = input.active === undefined ? u.active : input.active ? 1 : 0;
  await run("UPDATE users SET name=?, role=?, active=?, updated_at=? WHERE id=?", [name, role, active, now(), id]);
  await audit(actor, "update_user", "user", id, { before: { name: u.name, role: u.role, active: u.active }, after: { name, role, active } });
}

/** Owner: any non-owner. Chief: employees only, and only permissions Chief holds himself (never approval/assign rights). */
export async function setPermissions(actor: Actor, id: number, perms: string[], preset?: string) {
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "User not found.");
  if (u.role === "owner") throw new HttpError(400, "The owner always has full access.");
  let allowed: Permission[] = ALL_PERMISSIONS;
  if (actor.role !== "owner") {
    if (actor.role !== "chief" || u.role !== "employee") throw new HttpError(403, "Not allowed to change this person's permissions.");
    allowed = ALL_PERMISSIONS.filter((p) => can(actor, p) && !["approvals.decide", "tasks.assign", "tasks.view_all"].includes(p));
  }
  const requested = perms.filter((p): p is Permission => (ALL_PERMISSIONS as string[]).includes(p));
  const before = new Set<Permission>(u.perms);
  // Keep any permission the actor isn't allowed to touch exactly as it was.
  const next = new Set<Permission>();
  for (const p of ALL_PERMISSIONS) {
    if (allowed.includes(p)) {
      if (requested.includes(p)) next.add(p);
    } else if (before.has(p)) next.add(p);
  }
  const list = [...next];
  await run("UPDATE users SET permissions=?, preset=?, updated_at=? WHERE id=?", [JSON.stringify(list), preset ?? u.preset, now(), id]);
  await audit(actor, "set_permissions", "user", id, {
    added: list.filter((p) => !before.has(p)), removed: [...before].filter((p) => !next.has(p)),
  });
}

export async function resetPassword(actor: Actor, id: number) {
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "User not found.");
  const allowed = actor.role === "owner" ? u.role !== "owner" || id === actor.id : actor.role === "chief" && u.role === "employee";
  if (!allowed) throw new HttpError(403, "You cannot reset this person's password.");
  const temp = generateTempPassword();
  await run("UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL, updated_at=? WHERE id=?", [
    await hashPassword(temp), now(), id,
  ]);
  await audit(actor, "reset_password", "user", id, { target: u.username });
  return temp;
}

export async function changeOwnPassword(actor: Actor, current: string, next: string) {
  const u = await one("SELECT password_hash FROM users WHERE id=?", [actor.id]);
  if (!u || !(await bcrypt.compare(current, u.password_hash))) throw new HttpError(400, "Current password is wrong.");
  validatePassword(next);
  if (next === current) throw new HttpError(400, "Choose a different password.");
  await run("UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?", [await hashPassword(next), now(), actor.id]);
  await audit(actor, "change_own_password", "user", actor.id);
}

/* ---------- API keys ---------- */
export async function listKeys(userId?: number): Promise<Row[]> {
  return all(
    `SELECT k.id,k.user_id,k.label,k.prefix,k.active,k.last_used_at,k.created_at,k.revoked_at,u.name AS user_name
     FROM api_keys k JOIN users u ON u.id=k.user_id ${userId ? "WHERE k.user_id=?" : ""} ORDER BY k.created_at DESC`,
    userId ? [userId] : [],
  );
}
export async function createKey(actor: Actor, userId: number, label: string) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner manages API access.");
  const u = await getUser(userId);
  if (!u) throw new HttpError(404, "User not found.");
  const k = newApiKey();
  const r = await run("INSERT INTO api_keys (user_id,label,prefix,key_hash,created_by,created_at) VALUES (?,?,?,?,?,?)", [
    userId, label.trim() || "API key", k.prefix, k.hash, actor.id, now(),
  ]);
  await audit(actor, "create_api_key", "api_key", r.id, { user: u.username, label, prefix: k.prefix });
  return k.key;
}
export async function setKeyActive(actor: Actor, keyId: number, active: boolean) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner manages API access.");
  await run("UPDATE api_keys SET active=? WHERE id=? AND revoked_at IS NULL", [active ? 1 : 0, keyId]);
  await audit(actor, active ? "enable_api_key" : "disable_api_key", "api_key", keyId);
}
export async function revokeKey(actor: Actor, keyId: number) {
  if (actor.role !== "owner") throw new HttpError(403, "Only the owner manages API access.");
  await run("UPDATE api_keys SET active=0, revoked_at=? WHERE id=?", [now(), keyId]);
  await audit(actor, "revoke_api_key", "api_key", keyId);
}
