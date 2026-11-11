import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { one, run, now, type Row } from "./db";
import { ALL_PERMISSIONS, type Permission, type Role } from "./constants";

export type Actor = {
  id: number;
  username: string;
  name: string;
  role: Role;
  perms: Set<Permission>;
  via: "session" | "api" | "system";
  mustChangePassword: boolean;
  /** The account is an AI agent (set by the Owner). Shown as a badge next to its work. */
  isAgent?: boolean;
  /** API calls only: which key was used, and the request / run this call belongs to (written to the change history). */
  keyId?: number;
  keyLabel?: string;
  requestId?: string;
  runId?: string;
};

export class HttpError extends Error {
  /** `code` is a short, stable machine-readable reason; when left out the API derives one from the status. */
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

const COOKIE = "crm_session";
const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 24) throw new Error("AUTH_SECRET must be set (24+ chars)");
  return new TextEncoder().encode(s);
};

export function can(actor: Actor, perm: Permission): boolean {
  return actor.role === "owner" || actor.perms.has(perm);
}
export function requirePerm(actor: Actor, perm: Permission) {
  if (!can(actor, perm)) throw new HttpError(403, `Your account is not allowed to do this (${perm}).`);
}
export const isManager = (a: Actor) => a.role === "owner" || a.role === "chief";

function toActor(u: Row, via: Actor["via"]): Actor {
  let perms: Permission[] = [];
  try {
    perms = (JSON.parse(u.permissions) as string[]).filter((p): p is Permission => (ALL_PERMISSIONS as string[]).includes(p));
  } catch {}
  // Time-limited migration access: after the Owner's chosen moment the permission silently stops applying.
  if (u.history_import_until && String(u.history_import_until) <= now()) perms = perms.filter((p) => p !== "history.import");
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    perms: new Set(perms), via, mustChangePassword: !!u.must_change_password, isAgent: !!u.is_agent,
  };
}

/* ---------- passwords ---------- */
export const hashPassword = (p: string) => bcrypt.hash(p, 11);
export function validatePassword(p: string) {
  if (p.length < 10) throw new HttpError(400, "Password must be at least 10 characters.");
}
export function generateTempPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(14);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
}

/* ---------- login / sessions ---------- */
const MAX_FAILS = 5;
const LOCK_MIN = 15;

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const generic = { ok: false as const, error: "Wrong username or password." };
  const u = await one("SELECT * FROM users WHERE username = ?", [username.trim()]);
  if (!u) {
    await bcrypt.compare(password, "$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali"); // timing
    return generic;
  }
  if (u.locked_until && u.locked_until > now()) return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  const good = await bcrypt.compare(password, u.password_hash);
  if (!good) {
    const fails = Number(u.failed_logins) + 1;
    await run("UPDATE users SET failed_logins=?, locked_until=? WHERE id=?", [
      fails >= MAX_FAILS ? 0 : fails,
      fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null,
      u.id,
    ]);
    return generic;
  }
  if (!u.active) return { ok: false, error: "This account is disabled. Contact the owner." };
  await run("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=? WHERE id=?", [now(), u.id]);
  const token = await new SignJWT({ uid: u.id, pv: String(u.password_hash).slice(-12) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 86400,
  });
  return { ok: true };
}

export async function logout() {
  (await cookies()).delete(COOKIE);
}

export async function getSessionActor(): Promise<Actor | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const u = await one("SELECT * FROM users WHERE id = ? AND active = 1", [payload.uid as number]);
    // Changing the password invalidates old sessions (pv = tail of password hash).
    if (!u || String(u.password_hash).slice(-12) !== payload.pv) return null;
    return toActor(u, "session");
  } catch {
    return null;
  }
}

/** For pages: redirects to login / forced password change. */
export async function requireUser(opts: { allowPasswordChange?: boolean } = {}): Promise<Actor> {
  const a = await getSessionActor();
  if (!a) redirect("/login");
  if (a.mustChangePassword && !opts.allowPasswordChange) redirect("/account?force=1");
  return a;
}

/* ---------- API keys ---------- */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function newApiKey() {
  const prefix = randomBytes(4).toString("hex");
  const key = `ctk_${prefix}_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: `ctk_${prefix}`, hash: sha(key) };
}

export async function getActorFromKey(rawKey: string): Promise<Actor | null> {
  const key = rawKey.trim();
  if (!key) return null;
  const k = await one(
    `SELECT k.id AS key_id, k.label AS key_label, u.* FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.active = 1 AND k.revoked_at IS NULL AND u.active = 1`,
    [sha(key)],
  );
  if (!k) return null;
  await run("UPDATE api_keys SET last_used_at=? WHERE id=?", [now(), k.key_id]);
  return { ...toActor(k, "api"), keyId: k.key_id as number, keyLabel: k.key_label as string };
}

export async function getApiActor(req: Request): Promise<Actor> {
  const h = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const key = m ? m[1] : h.startsWith("ctk_") ? h : null;
  if (!key) throw new HttpError(401, "Missing API key. Send header: Authorization: Bearer <key>");
  const actor = await getActorFromKey(key);
  if (!actor) throw new HttpError(401, "Invalid, revoked or disabled API key.");
  return actor;
}

/** Scripts/tests only: build an actor straight from a user id. */
export async function actorById(id: number, via: Actor["via"] = "system"): Promise<Actor> {
  const u = await one("SELECT * FROM users WHERE id=?", [id]);
  if (!u) throw new Error("no such user");
  return toActor(u, via);
}
