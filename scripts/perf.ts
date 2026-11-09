// Run: npx tsx scripts/perf.ts [label]   — page-level timings and DB round trips on a seeded, realistic dataset.
// SIM_MS=25 adds a simulated network round trip to every DB call (what a remote Turso database costs).
import { rmSync } from "node:fs";
const DB = "data/perf-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam"; process.env.OWNER_PASSWORD = "owner-password-123"; process.env.APP_TIMEZONE = "Asia/Hebron";
const SIM = Number(process.env.SIM_MS ?? 0);

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const dbm = await import("../src/lib/db");
  const { ready, tx, all } = dbm;
  const c = await ready();
  const owner = await actorById(1, "api");
  const t0 = new Date().toISOString();
  const N = 3000;
  // seed through raw SQL (fast); only columns that exist in every version
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  stmts.push({ sql: "INSERT INTO users (username,name,role,password_hash,permissions,active,created_at,updated_at) VALUES ('emp1','Emp One','employee','x','[\"leads.view_own\"]',1,?,?)", args: [t0, t0] });
  await tx(stmts);
  const camp = (await all("SELECT id FROM campaigns ORDER BY id LIMIT 1"))[0].id as number;
  await c.execute({ sql: "UPDATE campaigns SET status='active' WHERE id=?", args: [camp] });
  for (let s = 0; s < N; s += 500) {
    const b: { sql: string; args: (string | number | null)[] }[] = [];
    for (let i = s; i < Math.min(N, s + 500); i++) {
      const day = new Date(Date.now() - (i % 200) * 86400000).toISOString();
      b.push({ sql: "INSERT INTO leads (id,company,website,domain,country,market,stage,owner_id,is_demo,created_by,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?,?,?,0,1,?,?,?)", args: [i + 1, `Dealer ${i}`, `https://d${i}.example`, `d${i}.example`, "US", "us", ["new", "ready", "contacted", "replied", "interested"][i % 5], i % 7 === 0 ? 2 : 1, day, day, day] });
      b.push({ sql: "INSERT INTO contacts (lead_id,name,email,is_primary,created_at,updated_at) VALUES (?,?,?,1,?,?)", args: [i + 1, `Boss ${i}`, `b${i}@d${i}.example`, day, day] });
      b.push({ sql: "INSERT INTO contacts (lead_id,name,email,is_primary,created_at,updated_at) VALUES (?,?,?,0,?,?)", args: [i + 1, `Sales ${i}`, `s${i}@d${i}.example`, day, day] });
      b.push({ sql: "INSERT INTO lead_campaigns (lead_id,campaign_id,status,is_original,added_by,joined_at) VALUES (?,?,'active',1,1,?)", args: [i + 1, camp, day] });
      for (let k = 0; k < 6; k++) b.push({ sql: "INSERT INTO activities (lead_id,type,message_kind,channel,outcome,title,body,actor_id,occurred_at,created_at,is_demo,occurred_precision) VALUES (?,?,?,?,?,?,?,1,?,?,0,'time')", args: [i + 1, k % 3 === 0 ? "message" : k % 3 === 1 ? "reply" : "research", k % 3 === 0 ? (k === 0 ? "first_email" : "follow_up") : null, "email", k % 3 === 0 ? "sent" : k % 3 === 1 ? "reply_received" : null, `Item ${k}`, "body text", new Date(Date.now() - (i % 120) * 86400000 - k * 3600000).toISOString(), day] });
    }
    await tx(b);
  }
  // 600 tasks (many linked to message versions with approvals), 120 versions
  const b2: { sql: string; args: (string | number | null)[] }[] = [];
  for (let i = 0; i < 120; i++) {
    const lead = i + 1;
    b2.push({ sql: "INSERT INTO message_versions (lead_id,contact_id,channel,campaign_id,version,subject,body,content_hash,created_by,created_at) VALUES (?,(SELECT id FROM contacts WHERE lead_id=? LIMIT 1),'email',?,1,?,?,?,1,?)", args: [lead, lead, camp, `Subject ${i}`, "Body ".repeat(40), `h${i}`, t0] });
  }
  await tx(b2);
  const vids = (await all("SELECT id,lead_id FROM message_versions ORDER BY id")).map((r) => [r.id as number, r.lead_id as number]);
  const b3: { sql: string; args: (string | number | null)[] }[] = [];
  for (const [vid, lead] of vids) {
    b3.push({ sql: "INSERT INTO send_authorizations (message_version_id,lead_id,contact_id,channel,campaign_id,kind,permitted_action,approver_id,status,created_at) VALUES (?,?,NULL,'email',?,'editorial','first_email',1,'active',?)", args: [vid, lead, camp, t0] });
    if (vid % 2 === 0) b3.push({ sql: "INSERT INTO send_authorizations (message_version_id,lead_id,contact_id,channel,campaign_id,kind,permitted_action,approver_id,status,created_at) VALUES (?,?,NULL,'email',?,'send','follow_up',1,'active',?)", args: [vid, lead, camp, t0] });
  }
  for (let i = 0; i < 600; i++) {
    const day = new Date(Date.now() + ((i % 3) - 1) * 86400000).toISOString();
    const v = i < vids.length ? vids[i] : null;
    b3.push({ sql: "INSERT INTO tasks (lead_id,assignee_id,created_by,title,task_type,status,due_at,created_at,updated_at,scheduled_at,channel,action_type,campaign_id,message_version_id,is_demo) VALUES (?,?,1,?,NULL,'todo',?,?,?,?,'email','follow_up',?,?,0)", args: [i + 1, i % 2 ? 1 : 2, `Task ${i}`, day, t0, t0, day, camp, v ? v[0] : null] });
  }
  await tx(b3);

  // count DB round trips (and add simulated latency)
  let calls = 0;
  const wrap = <T extends (...a: never[]) => Promise<unknown>>(fn: T) => (async (...a: never[]) => { calls++; if (SIM) await new Promise((r) => setTimeout(r, SIM)); return fn.apply(c, a); }) as unknown as T;
  c.execute = wrap(c.execute.bind(c)) as typeof c.execute;
  c.batch = wrap(c.batch.bind(c)) as typeof c.batch;

  const R = await import("../src/lib/service/reports");
  const L = await import("../src/lib/service/leads");
  const T = await import("../src/lib/service/tasks");
  const SCH = await import("../src/lib/service/schedule");
  const S = await import("../src/lib/service/sends");
  const emp = await actorById(2, "api");
  const cases: [string, () => Promise<unknown>][] = [
    ["Dashboard (owner, all data)", () => R.getDashboard(owner, { all: true })],
    ["Leads list (page 1, 50)", () => L.listLeads(owner, { page: 1, pageSize: 50 })],
    ["Leads search 'dealer 15'", () => L.listLeads(owner, { q: "dealer 15", page: 1, pageSize: 50 })],
    ["Lead page", () => L.getLead(owner, 5)],
    ["Tasks list (all, limit 300)", () => T.listTasks(owner, { open: true })],
    ["Today & Tomorrow", () => SCH.schedule(owner, { from: dbm.todayYmd(), to: dbm.addDays(dbm.todayYmd(), 1) })],
    ["Send approvals page", () => S.pendingSendApprovals(owner)],
    ["My work (employee)", () => T.listTasks(emp, { open: true })],
  ];
  const label = process.argv[2] ?? "run";
  console.log(`\n${label}  (${N} leads, ${await all("SELECT COUNT(*) AS n FROM activities").then((r) => r[0].n)} activities, 600 tasks, 120 versions; simulated round trip ${SIM} ms)`);
  console.log("page".padEnd(34), "DB calls".padStart(9), "time ms".padStart(9));
  for (const [name, fn] of cases) {
    await fn().catch(() => null); // warm
    calls = 0;
    const s = performance.now();
    try { await fn(); } catch (e) { console.log(name.padEnd(34), "ERROR", (e as Error).message.slice(0, 60)); continue; }
    console.log(name.padEnd(34), String(calls).padStart(9), (performance.now() - s).toFixed(0).padStart(9));
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
