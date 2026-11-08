/**
 * Phase 0 — read-only baseline. NEVER migrates or writes (it uses the raw driver, not src/lib/db).
 *
 *   npx tsx scripts/baseline.ts                       # print the baseline for DATABASE_URL (default file:./data/crm.db)
 *   npx tsx scripts/baseline.ts --out data/baselines/before.json
 *   npx tsx scripts/baseline.ts --compare data/baselines/before.json   # after a migration / restore: reconcile
 *
 * Counts and fingerprints use only columns that existed BEFORE the campaign upgrade, so a baseline taken on the old
 * schema must still match after the additive migration. Any difference is printed; exit code 1 if there is one.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import fs from "node:fs";

const url = process.env.BASELINE_DATABASE_URL || process.env.DATABASE_URL || "file:./data/crm.db";
const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

const FINGERPRINT: Record<string, string[]> = {
  users: ["id", "username", "role", "active"],
  leads: ["id", "company", "domain", "stage", "owner_id", "created_by", "lead_date", "lead_date_precision", "created_at", "external_id", "historical_only", "is_demo"],
  contacts: ["id", "lead_id", "email", "phone", "email_status", "is_primary"],
  activities: ["id", "lead_id", "task_id", "parent_id", "type", "message_kind", "channel", "outcome", "actor_id", "occurred_at", "occurred_precision", "created_at", "external_id", "imported_by", "is_demo"],
  tasks: ["id", "lead_id", "assignee_id", "created_by", "status", "due_at", "title", "task_type", "approval_from", "completed_at", "is_demo"],
  approvals: ["id", "task_id", "lead_id", "submitted_by", "kind", "requires", "status", "decided_by", "decided_at", "is_demo"],
  audit_log: ["id", "action", "entity", "entity_id", "created_at"],
  lists: ["id", "kind", "key", "label"],
};

async function table(name: string) {
  const info = await db.execute(`PRAGMA table_info(${name})`);
  return info.rows.map((r) => String(r.name));
}
async function scalar(sql: string) {
  return Number((await db.execute(sql)).rows[0]?.n ?? 0);
}
async function groups(sql: string) {
  const r = await db.execute(sql);
  return Object.fromEntries(r.rows.map((x) => [String(x.k ?? "null"), Number(x.n)]));
}

async function build() {
  const out: Record<string, unknown> = { taken_at: new Date().toISOString(), database: url.replace(/\/\/.*@/, "//***@"), tables: {} };
  const tables: Record<string, { rows: number; max_id: number; fingerprint: string }> = {};
  for (const [t, wanted] of Object.entries(FINGERPRINT)) {
    const cols = await table(t);
    if (!cols.length) continue;
    const use = wanted.filter((c) => cols.includes(c));
    const rows = (await db.execute(`SELECT ${use.join(",")} FROM ${t} ORDER BY id`)).rows;
    const h = createHash("sha256");
    for (const r of rows) h.update(JSON.stringify(use.map((c) => r[c] ?? null)) + "\n");
    tables[t] = { rows: rows.length, max_id: Number((await db.execute(`SELECT COALESCE(MAX(id),0) AS n FROM ${t}`)).rows[0].n), fingerprint: h.digest("hex") };
  }
  out.tables = tables;
  const lc = await table("leads");
  out.business = {
    leads_real: await scalar("SELECT COUNT(*) AS n FROM leads WHERE is_demo=0"),
    leads_test: await scalar("SELECT COUNT(*) AS n FROM leads WHERE is_demo=1"),
    leads_historical_only: lc.includes("historical_only") ? await scalar("SELECT COUNT(*) AS n FROM leads WHERE historical_only=1") : "n/a",
    leads_unknown_date: lc.includes("lead_date") ? await scalar("SELECT COUNT(*) AS n FROM leads WHERE lead_date IS NULL AND is_demo=0") : "n/a",
    leads_by_stage: await groups("SELECT stage AS k, COUNT(*) AS n FROM leads WHERE is_demo=0 GROUP BY stage"),
    activities_by_type_real: await groups("SELECT type AS k, COUNT(*) AS n FROM activities WHERE is_demo=0 GROUP BY type"),
    messages_by_kind_real: await groups("SELECT COALESCE(message_kind,'none') AS k, COUNT(*) AS n FROM activities WHERE is_demo=0 AND type='message' GROUP BY message_kind"),
    replies_real: await scalar("SELECT COUNT(*) AS n FROM activities WHERE is_demo=0 AND type='reply'"),
    bounces_real: await scalar("SELECT COUNT(*) AS n FROM activities WHERE is_demo=0 AND outcome='bounced'"),
    contacts_by_status: await groups("SELECT email_status AS k, COUNT(*) AS n FROM contacts GROUP BY email_status"),
    tasks_by_status_real: await groups("SELECT status AS k, COUNT(*) AS n FROM tasks WHERE is_demo=0 GROUP BY status"),
    approvals_by_status_real: await groups("SELECT status AS k, COUNT(*) AS n FROM approvals WHERE is_demo=0 GROUP BY status"),
    suppressed_contacts: await scalar("SELECT COUNT(*) AS n FROM contacts WHERE email_status IN ('opted_out','bounced')"),
  };
  out.schema_version = await scalar("SELECT COALESCE(MAX(version),0) AS n FROM schema_version").catch(() => 0);
  return out;
}

function flatten(o: unknown, p = ""): Record<string, unknown> {
  if (o && typeof o === "object") return Object.entries(o as object).reduce((a, [k, v]) => ({ ...a, ...flatten(v, p ? `${p}.${k}` : k) }), {});
  return { [p]: o };
}

(async () => {
  const args = process.argv.slice(2);
  const arg = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const now = await build();
  const out = arg("--out");
  if (out) { fs.mkdirSync(out.replace(/\/[^/]*$/, "") || ".", { recursive: true }); fs.writeFileSync(out, JSON.stringify(now, null, 2)); console.log(`Baseline written to ${out}`); }
  const cmp = arg("--compare");
  if (cmp) {
    const before = flatten(JSON.parse(fs.readFileSync(cmp, "utf8")));
    const after = flatten(now);
    const skip = new Set(["taken_at", "database", "schema_version"]);
    const diffs = Object.keys({ ...before, ...after }).filter((k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!diffs.length) console.log("RECONCILED: every count and fingerprint matches the baseline.");
    else { console.log("DIFFERENCES (each must be explained):"); for (const k of diffs) console.log(`  ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`); process.exit(1); }
  } else if (!out) console.log(JSON.stringify(now, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
