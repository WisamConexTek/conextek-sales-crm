import { createClient, type Client, type InValue } from "@libsql/client";
import bcrypt from "bcryptjs";
import { MIGRATIONS } from "./schema";
import { DEFAULT_LISTS, PRESETS, type ListKind } from "./constants";

type G = typeof globalThis & { __crmClient?: Client; __crmReady?: Promise<void> };
const g = globalThis as G;

function client(): Client {
  if (!g.__crmClient) {
    const url = process.env.DATABASE_URL || "file:./data/crm.db";
    if (url.startsWith("file:")) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const path = url.slice(5).replace(/^\.\//, "");
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir) fs.mkdirSync(dir, { recursive: true });
    }
    g.__crmClient = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  }
  return g.__crmClient;
}

export function now(): string {
  return new Date().toISOString();
}

async function migrate(c: Client) {
  await c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const r = await c.execute("SELECT COALESCE(MAX(version),0) AS v FROM schema_version");
  let current = Number(r.rows[0].v);
  while (current < MIGRATIONS.length) {
    await c.executeMultiple(MIGRATIONS[current]);
    current++;
    await c.execute({ sql: "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", args: [current, now()] });
  }
}

async function bootstrap(c: Client) {
  const lists = await c.execute("SELECT COUNT(*) AS n FROM lists");
  if (Number(lists.rows[0].n) === 0) {
    const stmts: { sql: string; args: InValue[] }[] = [];
    for (const [kind, items] of Object.entries(DEFAULT_LISTS)) {
      items.forEach((it, i) =>
        stmts.push({
          sql: "INSERT OR IGNORE INTO lists (kind,key,label,flag,position) VALUES (?,?,?,?,?)",
          args: [kind, it.key, it.label, it.flag ?? null, i],
        }),
      );
    }
    await c.batch(stmts, "write");
  }
  const users = await c.execute("SELECT COUNT(*) AS n FROM users");
  if (Number(users.rows[0].n) === 0) {
    const username = process.env.OWNER_USERNAME;
    const password = process.env.OWNER_PASSWORD;
    if (username && password) {
      const t = now();
      await c.execute({
        sql: `INSERT INTO users (username,name,role,preset,permissions,password_hash,must_change_password,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [
          username, process.env.OWNER_NAME || username, "owner", "owner",
          JSON.stringify(PRESETS.owner.perms), await bcrypt.hash(password, 11), 1, t, t,
        ],
      });
      await c.execute({
        sql: "INSERT INTO audit_log (actor_name,via,action,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?)",
        args: ["system", "system", "bootstrap_owner", "user", "1", JSON.stringify({ username }), t],
      });
    }
  }
}

export function ready(): Promise<Client> {
  const c = client();
  if (!g.__crmReady) {
    g.__crmReady = (async () => {
      await migrate(c);
      await bootstrap(c);
    })().catch((e) => {
      g.__crmReady = undefined;
      throw e;
    });
  }
  return g.__crmReady.then(() => c);
}

// ---- tiny query helpers (rows come back as plain objects) ----
export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function plain(rows: unknown[]): Row[] {
  return rows.map((r) => ({ ...(r as object) }) as Row);
}
export async function all(sql: string, args: InValue[] = []): Promise<Row[]> {
  const c = await ready();
  return plain((await c.execute({ sql, args })).rows);
}
export async function one(sql: string, args: InValue[] = []): Promise<Row | null> {
  return (await all(sql, args))[0] ?? null;
}
export async function run(sql: string, args: InValue[] = []): Promise<{ id: number; changes: number }> {
  const c = await ready();
  const r = await c.execute({ sql, args });
  return { id: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
}
export async function tx(stmts: { sql: string; args?: InValue[] }[]) {
  const c = await ready();
  return c.batch(stmts.map((s) => ({ sql: s.sql, args: s.args ?? [] })), "write");
}

// ---- timezone helpers ----
export const TZ = () => process.env.APP_TIMEZONE || "UTC";

function tzOffsetMs(at: Date, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}
/** UTC instant of local midnight for a YYYY-MM-DD date in the app timezone. */
export function localMidnight(ymd: string, tz = TZ()): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}
export function todayYmd(tz = TZ(), at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function getListMap(kind: ListKind): Promise<Record<string, string>> {
  const rows = await all("SELECT key,label FROM lists WHERE kind=?", [kind]);
  return Object.fromEntries(rows.map((r) => [r.key, r.label]));
}
