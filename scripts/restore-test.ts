/**
 * Phase 0 — prove a backup restores. Builds a throwaway local database from an SQL dump and prints its baseline.
 * Never touches production.
 *
 *   turso db shell <db> .dump > backup.sql        (or: sqlite3 data/crm.db .dump > backup.sql)
 *   npx tsx scripts/restore-test.ts backup.sql data/baselines/before.json
 *
 * With a baseline file as the second argument the restored data is reconciled against it.
 */
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [dump, baseline] = process.argv.slice(2);
if (!dump || !fs.existsSync(dump)) { console.error("usage: restore-test.ts <backup.sql> [baseline.json]"); process.exit(2); }
const file = "data/restore-test.db";
fs.mkdirSync("data", { recursive: true });
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
(async () => {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(fs.readFileSync(dump, "utf8"));
  c.close();
  const args = ["tsx", "scripts/baseline.ts", ...(baseline ? ["--compare", baseline] : [])];
  try {
    execFileSync("npx", args, { stdio: "inherit", env: { ...process.env, BASELINE_DATABASE_URL: `file:${file}` } });
  } finally { for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
