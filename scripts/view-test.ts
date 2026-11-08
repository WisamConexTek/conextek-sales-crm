// Run: npm test   (phase 3: Today/Tomorrow work view, campaign reporting, lead operations summary)
import { rmSync } from "node:fs";
const DB = "data/view-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";
process.env.APP_TIMEZONE = "Asia/Hebron";

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, run, ready, todayYmd, addDays, localMidnight } = await import("../src/lib/db");
  const U = await import("../src/lib/service/users");
  const L = await import("../src/lib/service/leads");
  const C = await import("../src/lib/service/campaigns");
  const T = await import("../src/lib/service/tasks");
  const V = await import("../src/lib/service/schedule");
  const S = await import("../src/lib/service/sends");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const throws = async (fn: () => Promise<unknown>, name: string, re?: RegExp) => { try { await fn(); ok(false, name + " (did not throw)"); } catch (e) { ok(re ? re.test((e as Error).message) : true, name); } };
  const owner = await actorById(1, "api");
  const chief = await actorById((await U.createUser(owner, { username: "chief", name: "Chief", role: "chief", preset: "chief" })).id, "api");
  const emp = await actorById((await U.createUser(owner, { username: "out", name: "Outreach", role: "employee", preset: "outreach" })).id, "api");
  const emp2 = await actorById((await U.createUser(owner, { username: "res", name: "Researcher", role: "employee", preset: "researcher" })).id, "api");
  const us = await C.createCampaign(chief, { name: "US Test", status: "active" });
  const gulf = await C.createCampaign(chief, { name: "Gulf Test", status: "active" });

  const today = todayYmd(), tomorrow = addDays(today, 1);
  const iso = (ymd: string, h: number) => new Date(localMidnight(ymd).getTime() + h * 3600000).toISOString();
  const lead = await L.createLead(owner, { company: "Work Cars", owner_id: emp.id, campaign_id: us, contacts: [{ name: "Wes", email: "w@work.test" }] });

  console.log("Today / Tomorrow work view");
  const mk = (title: string, extra: Record<string, unknown>) => T.createTask(chief, { title, lead_id: lead, assignee_id: emp.id, campaign_id: us, channel: "email", ...extra });
  const future = new Date(Date.now() + 3 * 3600000).toISOString();
  const past = new Date(Date.now() - 3 * 3600000).toISOString();
  const tReady = await mk("ready one", { scheduled_at: future, prep_status: "ready_for_execution" });
  const tPlanned = await mk("planned one", { scheduled_at: future, prep_status: "draft_needed" });
  const tBlocked = await mk("blocked one", { scheduled_at: future, blockers: "waiting for contact validation" });
  const tOver = await mk("overdue one", { scheduled_at: past });
  const tTomorrow = await mk("tomorrow one", { scheduled_at: `${tomorrow}T11:00:00Z` });
  const tDue = await mk("due-date only", { due_at: `${today}T23:30` });
  await T.completeTask(chief, await mk("done one", { scheduled_at: past, approval: "none" }));
  const sch = await V.schedule(chief, {});
  const st = (id: number) => sch.rows.find((r) => r.id === id)?.state;
  // the test only makes sense if "3 hours from now" and "3 hours ago" are still today in Hebron
  const sameDay = (iso: string) => iso >= localMidnight(today).toISOString() && iso < localMidnight(addDays(today, 1)).toISOString();
  if (sameDay(future) && sameDay(past)) {
    ok(st(tReady) === "ready" && st(tPlanned) === "planned" && st(tBlocked) === "blocked" && st(tOver) === "overdue", "ready / planned / blocked / overdue are told apart");
    ok(sch.rows.some((r) => r.state === "completed"), "completed work is shown as completed");
  } else ok(true, "(state test skipped near midnight)");
  ok(sch.rows.find((r) => r.id === tDue)?.at_source === "due_at" && sch.rows.find((r) => r.id === tDue)?.at === (await one("SELECT due_at FROM tasks WHERE id=?", [tDue]))!.due_at, "a task with only a due date is placed on that date");
  ok(!sch.rows.some((r) => r.id === tTomorrow), "tomorrow's task is not in today");
  const tom = await V.schedule(chief, { view: "tomorrow" });
  ok(tom.from === tomorrow && tom.rows.some((r) => r.id === tTomorrow), "tomorrow view");
  ok((await V.schedule(chief, { state: "blocked" })).rows.every((r) => r.state === "blocked") && (await V.schedule(chief, { campaign: gulf })).total === 0, "filters: status and campaign");
  ok((await V.schedule(chief, { channel: "linkedin" })).total === 0 && (await V.schedule(chief, { employee: emp.id })).total > 0 && (await V.schedule(chief, { employee: emp2.id })).total === 0, "filters: channel and employee");
  ok((await V.schedule(emp2, {})).total === 0 && (await V.schedule(emp, { employee: emp2.id })).rows.every((r) => r.assignee_id === emp.id), "an employee sees only their own work, whatever employee filter is sent");
  await throws(() => V.schedule(chief, { state: "weird" }), "unknown status filter is refused", /state/);
  // day boundaries follow the Hebron clock across the 24 Oct 2026 clock change
  const oct = await V.schedule(chief, { date: "2026-10-24" });
  ok(oct.from === "2026-10-24" && oct.timezone === "Asia/Hebron", "reports the timezone and the requested day");
  const t1 = await T.createTask(chief, { title: "late night Oct 23", assignee_id: emp.id, scheduled_at: "2026-10-23T23:30:00+03:00" });
  const t2 = await T.createTask(chief, { title: "after midnight Oct 24", assignee_id: emp.id, scheduled_at: "2026-10-24T00:15:00+03:00" });
  const d23 = await V.schedule(chief, { date: "2026-10-23" }), d24 = await V.schedule(chief, { date: "2026-10-24" });
  ok(d23.rows.some((r) => r.id === t1) && !d23.rows.some((r) => r.id === t2) && d24.rows.some((r) => r.id === t2) && !d24.rows.some((r) => r.id === t1), "Oct 23 23:30 and Oct 24 00:15 (Hebron) land on their own days");
  await run("UPDATE contacts SET email_status='opted_out' WHERE lead_id=?", [lead]);
  ok((await V.schedule(chief, {})).rows.find((r) => r.id === tReady)?.state === "blocked", "an opted-out contact turns scheduled work into blocked");
  await run("UPDATE contacts SET email_status='ok' WHERE lead_id=?", [lead]);

  console.log("Campaign report");
  const mkSend = async (leadId: number, kind: string, at: string, extra = "") => {
    const r = await run(`INSERT INTO activities (lead_id,type,message_kind,channel,outcome,actor_id,occurred_at,created_at,occurred_precision${extra ? ",parent_id" : ""}) VALUES (?,'message',?,'email','sent',?,?,?,'time'${extra ? ",?" : ""})`, extra ? [leadId, kind, emp.id, at, at, Number(extra)] : [leadId, kind, emp.id, at, at]);
    return r.id;
  };
  const a1 = await L.createLead(owner, { company: "A1", owner_id: emp.id, campaign_id: us, contacts: [{ name: "a", email: "a1@x.test" }] });
  const a2 = await L.createLead(owner, { company: "A2", owner_id: emp.id, campaign_id: us, contacts: [{ name: "a", email: "a2@x.test" }] });
  const a3 = await L.createLead(owner, { company: "A3", owner_id: emp.id, campaign_id: us, contacts: [{ name: "a", email: "a3@x.test" }] });
  const s1 = await mkSend(a1, "first_email", "2026-09-01T08:00:00.000Z");
  await mkSend(a2, "first_email", "2026-09-02T08:00:00.000Z");
  const s3 = await mkSend(a3, "first_email", "2026-09-03T08:00:00.000Z");
  await mkSend(a1, "follow_up", "2026-09-10T08:00:00.000Z");
  await run("INSERT INTO activities (lead_id,type,outcome,actor_id,occurred_at,created_at,occurred_precision,parent_id) VALUES (?,'outcome','bounced',?,?,?, 'time',?)", [a3, emp.id, "2026-09-03T09:00:00.000Z", "2026-09-03T09:00:00.000Z", s3]);
  await run("INSERT INTO activities (lead_id,type,outcome,body,actor_id,occurred_at,created_at,occurred_precision,parent_id) VALUES (?,'reply','reply_received','yes',?,?,?, 'time',?)", [a1, emp.id, "2026-09-11T08:00:00.000Z", "2026-09-11T08:00:00.000Z", s1]);
  await run("UPDATE leads SET stage='interested' WHERE id=?", [a1]);
  await run("INSERT INTO activities (lead_id,type,message_kind,channel,outcome,actor_id,occurred_at,created_at,occurred_precision) VALUES (?,'message','first_email','email','sent',?,?,?,'unknown')", [a2, emp.id, "2026-09-05T08:00:00.000Z", "2026-09-05T08:00:00.000Z"]);
  const rep = await V.campaignReport(chief);
  const u = rep.campaigns.find((c) => c.id === us)!;
  ok(u.first_emails === 3 && u.follow_ups === 1 && u.replies === 1 && u.reply_leads === 1, "sends, follow-ups and replies count only recorded, dated activity (unknown-date send excluded)");
  ok(u.rates.reply_rate.numerator === 1 && u.rates.reply_rate.denominator === 3, "reply rate shows numerator and denominator (leads replied ÷ leads emailed)");
  ok(u.rates.first_email_bounce_rate.numerator === 1 && u.rates.first_email_bounce_rate.denominator === 3, "bounce rate = bounced first emails ÷ first emails");
  ok(u.positive_reply_leads === 1 && u.unique_leads === 4, "positive replies and unique leads");
  ok(u.preparation_backlog >= 2 && u.planned_tasks >= 5, "preparation backlog and planned work are counted from tasks, apart from sends");
  // approved scheduled: needs an active Owner send authorization on a version tied to the task
  const v = await S.createVersion(emp, { lead_id: lead, channel: "email", campaign_id: us, task_id: tReady, body: "Hello" });
  const before = (await V.campaignReport(chief, us)).campaigns[0].approved_scheduled;
  await S.authorize(chief, { message_version_id: v.id, kind: "editorial", permitted_action: "first_email" });
  const afterEditorial = (await V.campaignReport(chief, us)).campaigns[0].approved_scheduled;
  await S.authorize(owner, { message_version_id: v.id, kind: "send", permitted_action: "first_email" });
  const afterSend = (await V.campaignReport(chief, us)).campaigns[0].approved_scheduled;
  ok(before === 0 && afterEditorial === 0 && afterSend === 1, "an internal (editorial) approval is not counted as approved-to-send; the Owner's authorization is");
  const gulfRow = rep.campaigns.find((c) => c.id === gulf)!;
  ok(gulfRow.first_emails === 0 && gulfRow.rates.reply_rate.value === null, "an empty campaign shows zeros and no invented rate");
  // transfer: earlier activity stays with the original campaign
  await C.enrolLead(chief, a1, { campaign_id: gulf, transfer_from_campaign_id: us });
  await mkSend(a1, "follow_up", new Date().toISOString());
  const rep2 = await V.campaignReport(chief);
  ok(rep2.campaigns.find((c) => c.id === us)!.first_emails === 3 && rep2.campaigns.find((c) => c.id === gulf)!.follow_ups === 1 && rep2.campaigns.find((c) => c.id === gulf)!.first_emails === 0, "after a transfer, past activity stays with the original campaign and new activity goes to the new one");
  await throws(() => V.campaignReport(emp), "employees cannot read campaign reports", /managers/);
  ok(rep.unassigned_leads >= 0 && typeof rep.rules.attribution === "string", "report states its rules and unassigned count");

  console.log("Lead operations summary");
  const ops = await V.leadOperations(chief, lead);
  ok(ops.next_task && ops.restrictions.length === 0 && ops.crm_pending_sends === 0 && ops.active_send_authorizations === 1, "next task, restrictions, pending sends and authorizations");
  ok((await V.leadOperations(chief, a1)).last_communication?.type === "message", "last actual communication");
  await run("UPDATE contacts SET email_status='bounced' WHERE lead_id=?", [lead]);
  ok((await V.leadOperations(chief, lead)).restrictions.length === 1, "restrictions listed");

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
