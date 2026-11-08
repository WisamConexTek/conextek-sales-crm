// Run: npm test   (campaign foundations: migration 5 on a populated version-4 database, membership rules, task planning fields)
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const DB = "data/campaign-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, "data/campaign-before.json"]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_TIMEZONE = "Asia/Hebron";

async function main() {
  const { createClient } = await import("@libsql/client");
  const { MIGRATIONS } = await import("../src/lib/schema");
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));

  console.log("Migration 5 on a populated, pre-campaign database");
  const raw = createClient({ url: `file:./${DB}` });
  await raw.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let i = 0; i < 4; i++) { await raw.executeMultiple(MIGRATIONS[i]); await raw.execute({ sql: "INSERT INTO schema_version VALUES (?,?)", args: [i + 1, "2026-01-01T00:00:00Z"] }); }
  const T = "2026-10-01T10:00:00.000Z";
  const allPerms = JSON.stringify(["leads.view_all", "leads.create", "leads.edit", "leads.stage", "activity.record", "tasks.create_own", "tasks.assign", "tasks.view_all", "approvals.submit", "approvals.decide", "reports.view", "keys.manage"]);
  await raw.executeMultiple(`
    INSERT INTO users (username,name,role,preset,permissions,password_hash,created_at,updated_at) VALUES
      ('owner','Owner','owner','owner','["leads.view_all","leads.create","leads.edit","campaigns.manage"]','x','${T}','${T}'),
      ('chief','Chief','chief','chief','${allPerms}','x','${T}','${T}'),
      ('emp','Emp','employee','researcher','["leads.create","leads.edit","tasks.create_own"]','x','${T}','${T}');
    INSERT INTO lists (kind,key,label,flag,position) VALUES ('stage','new','New',NULL,0),('stage','contacted','Contacted',NULL,1),('stage','lost','Lost','lost',2),('task_type','research','Research','chief',0);
    INSERT INTO leads (company,stage,owner_id,notes,next_action,created_by,created_at,updated_at,lead_date,lead_date_precision) VALUES
      ('Alpha Motors','contacted',3,'Met at fair, call back','Send price list',3,'${T}','${T}','2026-05-02','day'),
      ('Beta Autos','lost',3,NULL,NULL,2,'${T}','${T}',NULL,NULL),
      ('Gamma Optout','contacted',3,NULL,NULL,2,'${T}','${T}','2026-06-01','day');
    INSERT INTO contacts (lead_id,name,email,email_status,created_at,updated_at) VALUES (1,'A','a@alpha.test','ok','${T}','${T}'),(3,'G','g@gamma.test','opted_out','${T}','${T}');
    INSERT INTO tasks (lead_id,assignee_id,created_by,title,instructions,status,due_at,created_at,updated_at) VALUES
      (1,3,2,'Follow up Alpha on 12 Nov','Use the second template','completed','2026-10-02T08:00:00.000Z','${T}','${T}'),
      (1,3,2,'Draft email','Short','todo','2026-11-12T08:00:00.000Z','${T}','${T}');
    INSERT INTO approvals (task_id,lead_id,submitted_by,kind,title,content,requires,status,created_at) VALUES (1,1,3,'draft','Alpha draft','Dear Alpha ...','wisam','approved','${T}');
    INSERT INTO activities (lead_id,type,message_kind,channel,outcome,actor_id,occurred_at,created_at) VALUES (1,'message','first_email','email','sent',3,'2026-09-01T08:00:00.000Z','${T}');
  `);
  raw.close();
  const run = (args: string[]) => execFileSync("npx", ["tsx", "scripts/baseline.ts", ...args], { env: { ...process.env, BASELINE_DATABASE_URL: `file:./${DB}` }, encoding: "utf8" });
  run(["--out", "data/campaign-before.json"]);

  const { ready, one, all, run: dbRun } = await import("../src/lib/db");
  await ready();
  let recon = "";
  try { recon = run(["--compare", "data/campaign-before.json"]); } catch (e) { recon = String((e as { stdout?: string }).stdout); }
  ok(recon.includes("RECONCILED"), "every count and fingerprint matches the pre-migration baseline");
  ok(Number((await one("SELECT COUNT(*) AS n FROM lead_campaigns"))!.n) === 0, "no lead is placed in a campaign without evidence");
  ok((await all("SELECT key FROM campaigns ORDER BY id")).map((r) => r.key).join() === "us_car_dealers,gulf_car_dealers,canton_fair" && (await all("SELECT key FROM channels")).length === 3, "ConexTek project, three campaigns and three channels exist");
  ok((await one("SELECT permissions FROM users WHERE username='chief'"))!.permissions.includes("campaigns.manage"), "existing Chief received campaigns.manage");
  ok((await one("SELECT stage,owner_id,lead_date FROM leads WHERE id=1"))!.stage === "contacted" && (await one("SELECT status FROM tasks WHERE id=1"))!.status === "completed", "contacted lead stays contacted and completed task stays completed");
  const arch = Number((await one("SELECT COUNT(*) AS n FROM legacy_archive"))!.n);
  ok(arch === 7, `legacy notes, next actions, task titles/instructions and approval text archived (${arch} rows)`);
  let blocked = false; try { await dbRun("UPDATE legacy_archive SET content='x'"); } catch { blocked = true; }
  let blocked2 = false; try { await dbRun("DELETE FROM legacy_archive"); } catch { blocked2 = true; }
  ok(blocked && blocked2, "legacy archive cannot be updated or deleted");
  // rerun: no duplicates
  const g = globalThis as unknown as { __crmReady?: unknown; __crmClient?: { close(): void } };
  g.__crmReady = undefined;
  await ready();
  ok(Number((await one("SELECT COUNT(*) AS n FROM legacy_archive"))!.n) === arch && Number((await one("SELECT COUNT(*) AS n FROM campaigns"))!.n) === 3, "re-running the migration creates no duplicates");

  console.log("Campaign membership");
  const { actorById } = await import("../src/lib/auth");
  const C = await import("../src/lib/service/campaigns");
  const L = await import("../src/lib/service/leads");
  const Tk = await import("../src/lib/service/tasks");
  const owner = await actorById(1, "api"), chief = await actorById(2, "api"), emp = await actorById(3, "api");
  const camps = await C.listCampaigns();
  const us = camps.find((c) => c.key === "us_car_dealers")!.id as number, gulf = camps.find((c) => c.key === "gulf_car_dealers")!.id as number, canton = camps.find((c) => c.key === "canton_fair")!.id as number;
  const throws = async (fn: () => Promise<unknown>, name: string, re?: RegExp) => { try { await fn(); ok(false, name + " (did not throw)"); } catch (e) { ok(re ? re.test((e as Error).message) : true, name); } };
  await throws(() => C.enrolLead(emp, 1, { campaign_id: us }), "an employee without campaigns.manage cannot enrol");
  const e1 = await C.enrolLead(chief, 1, { campaign_id: us, note: "found via US list" });
  ok(e1.changed && (await C.leadCampaigns(1))[0].is_original === 1, "enrol links the lead and marks the original source");
  ok((await C.enrolLead(chief, 1, { campaign_id: us })).changed === false && (await C.leadCampaigns(1)).length === 1, "enrolling again is idempotent");
  await throws(() => C.enrolLead(chief, 1, { campaign_id: gulf }), "a second active campaign needs an explicit transfer", /transfer_from_campaign_id/);
  await C.enrolLead(chief, 1, { campaign_id: gulf, transfer_from_campaign_id: us });
  const hist = await C.leadCampaigns(1);
  ok(hist.length === 2 && hist[0].status === "transferred" && hist[0].is_original === 1 && hist[1].status === "active" && hist[1].transferred_from === us, "transfer keeps history and original-source attribution");
  ok((await one("SELECT stage FROM leads WHERE id=1"))!.stage === "contacted" && Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE status='todo'"))!.n) === 1 && Number((await one("SELECT COUNT(*) AS n FROM activities WHERE type='message'"))!.n) === 1, "transfer does not reset the stage, create tasks or touch sends");
  await throws(() => C.enrolLead(chief, 3, { campaign_id: us }), "an opted-out lead cannot be enrolled in any campaign", /opted-out/);
  await throws(() => C.enrolLead(chief, 1, { campaign_id: canton, transfer_from_campaign_id: us }), "transfer from a campaign the lead is not active in is refused");
  const cnt = (await C.listCampaigns()).find((c) => c.id === gulf)!;
  ok(cnt.unique_leads === 1 && (await C.listCampaigns()).find((c) => c.id === us)!.unique_leads === 0, "unique-lead counts follow active membership");
  const lid = await L.createLead(owner, { company: "Delta Cars", campaign_id: canton });
  ok((await C.leadCampaigns(lid))[0]?.campaign_id === canton, "creating a lead inside a campaign links it automatically");
  const un = await C.unassignedLeads(chief);
  ok(un.rows.some((r) => r.company === "Beta Autos") && !un.rows.some((r) => r.company === "Alpha Motors") && !un.rows.some((r) => r.company === "Delta Cars"), "the review queue lists only leads with no campaign");
  const nc = await C.createCampaign(chief, { name: "Gulf Dealers 2027", target_markets: ["UAE", "KSA"], objective: "Open 10 accounts", owner_id: 2, status: "active" });
  ok((await C.getCampaign(nc)).status === "active" && (await C.getCampaign(nc)).target_markets === "UAE, KSA", "campaigns can be created with owner, markets, objective and status");
  await throws(() => C.createCampaign(emp, { name: "Nope" }), "creating a campaign needs permission");

  console.log("Task planning fields");
  const tid = await Tk.createTask(chief, { title: "Send first email", lead_id: 1, assignee_id: 3, scheduled_at: "2026-11-09T10:00:00+02:00", channel: "email", action_type: "send_first_email", prep_status: "draft_needed", campaign_id: gulf });
  const t1 = await one("SELECT * FROM tasks WHERE id=?", [tid]);
  ok(t1!.scheduled_at === "2026-11-09T08:00:00.000Z" && t1!.scheduled_input === "2026-11-09T10:00:00+02:00" && t1!.channel === "email" && t1!.prep_status === "draft_needed" && t1!.campaign_id === gulf, "task stores a real instant, keeps the original input and structured fields");
  await Tk.updateTask(emp, tid, { prep_status: "internal_review", blockers: "waiting for Chief" });
  ok((await one("SELECT prep_status,blockers FROM tasks WHERE id=?", [tid]))!.prep_status === "internal_review", "the assignee can update preparation status and blockers");
  await throws(() => Tk.updateTask(emp, tid, { scheduled_at: "2026-11-20T10:00:00Z" }), "the assignee cannot reschedule", /manager/);
  await Tk.updateTask(chief, tid, { scheduled_at: "2026-11-10T09:30:00Z", channel: "linkedin" });
  ok((await one("SELECT scheduled_at,channel FROM tasks WHERE id=?", [tid]))!.scheduled_at === "2026-11-10T09:30:00.000Z", "a manager can change schedule and channel");
  await throws(() => Tk.createTask(chief, { title: "x", scheduled_at: "next tuesday" }), "dates written as words are refused", /scheduled_at/);
  await throws(() => Tk.createTask(chief, { title: "x", channel: "fax" }), "unknown channels are refused", /channel/);
  await throws(() => Tk.createTask(chief, { title: "x", prep_status: "approved" }), "preparation status is a fixed vocabulary (not a sales stage or approval)");
  ok((await one("SELECT prep_status,scheduled_at FROM tasks WHERE id=1"))!.prep_status === null, "existing tasks keep unknown (NULL) preparation status and schedule");

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, "data/campaign-before.json"]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
