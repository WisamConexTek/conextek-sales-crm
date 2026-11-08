// Run: npm test   (phase 2: duplicate identity checks, versioned authorizations, confirmed sends, CRM-pending reconcile)
import { rmSync } from "node:fs";
const DB = "data/send-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";
process.env.APP_TIMEZONE = "Asia/Hebron";

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, all, run, ready } = await import("../src/lib/db");
  const U = await import("../src/lib/service/users");
  const L = await import("../src/lib/service/leads");
  const C = await import("../src/lib/service/campaigns");
  const D = await import("../src/lib/service/dedupe");
  const S = await import("../src/lib/service/sends");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const throws = async (fn: () => Promise<unknown>, name: string, re?: RegExp) => { try { await fn(); ok(false, name + " (did not throw)"); } catch (e) { ok(re ? re.test((e as Error).message) : true, name); } };
  const owner = await actorById(1, "api");
  const chief = await actorById((await U.createUser(owner, { username: "chief", name: "Chief", role: "chief", preset: "chief" })).id, "api");
  const emp = await actorById((await U.createUser(owner, { username: "out", name: "Outreach", role: "employee", preset: "outreach" })).id, "api");
  const hunter = await actorById((await U.createUser(owner, { username: "hunter", name: "Hunter", role: "employee", preset: "researcher" })).id, "api");
  const camp = await C.createCampaign(chief, { name: "Send Test", status: "active" });
  const camp2 = await C.createCampaign(chief, { name: "Other Campaign", status: "active" });

  console.log("Global duplicate check");
  const acme = await L.createLead(owner, { company: "Acme Motors LLC", website: "https://www.acme.com", contacts: [{ name: "A", email: "a@acme.com", phone: "+1 (555) 123-4567", linkedin: "https://www.linkedin.com/company/acme/" }] });
  const chk = (a: typeof owner, q: Parameters<typeof D.checkIdentity>[1]) => D.checkIdentity(a, q);
  ok((await chk(hunter, { emails: ["A@ACME.com"] })).decision === "duplicate", "same email is a duplicate (case-insensitive)");
  ok((await chk(hunter, { company: "Acme Motors Inc", website: "acme.com" })).decision === "duplicate", "same domain + same normalized name is a duplicate");
  const franchise = await chk(hunter, { company: "Acme Downtown", website: "acme.com" });
  ok(franchise.decision === "review" && franchise.matches[0].class === "ambiguous", "same domain, different business goes to review (franchises are not merged)");
  ok((await chk(hunter, { phones: ["555 123 4567"] })).decision === "review", "phone-only match is ambiguous");
  ok((await chk(hunter, { profiles: ["linkedin.com/company/acme"] })).decision === "review", "profile URL-only match is ambiguous");
  ok((await chk(hunter, { company: "Totally New Co", website: "new.example" })).decision === "clear", "no signals is clear");
  ok(franchise.matches[0].lead_id === null && franchise.matches[0].restricted_reference && franchise.matches[0].company === null, "an employee who cannot browse the lead still gets the warning, without its details");
  ok((await chk(chief, { emails: ["a@acme.com"] })).matches[0].lead_id === acme, "Chief sees the matching lead");
  const rv = await D.requestReview(hunter, { existing_lead_id: acme, proposed: { company: "Acme Downtown", website: "acme.com" } });
  ok(rv.created && (await D.requestReview(hunter, { existing_lead_id: acme, proposed: { company: "Acme Downtown", website: "acme.com" } })).created === false, "ambiguous matches go to a Chief review, once");
  await throws(() => D.listReviews(hunter), "an employee cannot read the review queue");
  await D.decideReview(chief, rv.id, { decision: "different", note: "separate dealership" });
  await throws(() => D.decideReview(chief, rv.id, { decision: "same" }), "a review is decided once", /already decided/);

  console.log("Versions and authorizations");
  const mkLead = async (company: string, email: string, stage = "ready") => {
    const id = await L.createLead(owner, { company, stage, campaign_id: camp, owner_id: emp.id, contacts: [{ name: company, email }] });
    const cid = (await one("SELECT id FROM contacts WHERE lead_id=?", [id]))!.id as number;
    return { id, cid };
  };
  const a = await mkLead("Alpha Cars", "x@alpha.test");
  const v1 = await S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, subject: "Hello", body: "Draft one" });
  ok(v1.version === 1 && (await S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, subject: "Hello", body: "Draft one" })).created === false, "identical text does not create a new version");
  await S.authorize(chief, { message_version_id: v1.id, kind: "editorial", permitted_action: "first_email" });
  ok(!(await S.checkEligibility(emp, v1.id)).eligible, "Chief's editorial approval is not authorization to send");
  await throws(() => S.authorize(chief, { message_version_id: v1.id, kind: "send", permitted_action: "first_email" }), "Chief cannot authorize a send", /Owner/);
  await throws(() => S.authorize(emp, { message_version_id: v1.id, kind: "editorial", permitted_action: "first_email" }), "an employee cannot approve");
  await S.authorize(owner, { message_version_id: v1.id, kind: "send", permitted_action: "first_email" });
  ok((await S.checkEligibility(emp, v1.id)).eligible, "Owner's send authorization makes the exact version eligible");
  const v2 = await S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, subject: "Hello", body: "Draft two (edited)" });
  const e2 = await S.checkEligibility(emp, v2.id), e1 = await S.checkEligibility(emp, v1.id);
  ok(v2.version === 2 && !e2.eligible && !e1.eligible, "editing creates a new version with no authorization; the old version can no longer be sent");
  ok((await one("SELECT COUNT(*) AS n FROM send_authorizations WHERE message_version_id=? AND status='active'", [v1.id]))!.n === 0, "editing voids the earlier version's authorizations");
  ok((await one("SELECT body FROM message_versions WHERE id=?", [v1.id]))!.body === "Draft one", "the earlier version's text is preserved");
  let imm = false; try { await run("UPDATE message_versions SET body='x' WHERE id=?", [v1.id]); } catch { imm = true; }
  ok(imm, "message versions are immutable");
  await S.authorize(owner, { message_version_id: v2.id, kind: "send", permitted_action: "first_email" });

  console.log("Confirmed send, recording and read-back");
  const sent = await S.confirmSend(emp, { event_id: "evt-alpha-1", message_version_id: v2.id, sent_at: "2026-11-08T10:00:00+02:00", evidence: "mailbox message-id <abc@mail>" });
  ok(sent.status === "RECORDED" && sent.activity_id, "confirmed send is saved with evidence and recorded");
  const act = await one("SELECT * FROM activities WHERE external_id='evt-alpha-1'");
  ok(act!.body === "Draft two (edited)" && act!.occurred_at === "2026-11-08T08:00:00.000Z" && act!.message_kind === "first_email" && act!.contact_id === a.cid, "stored activity matches exactly (version text, instant, kind, recipient)");
  ok((await one("SELECT stage FROM leads WHERE id=?", [a.id]))!.stage === "contacted", "pre-contact stage moves to Contacted");
  const again = await S.confirmSend(emp, { event_id: "evt-alpha-1", message_version_id: v2.id, sent_at: "2026-11-08T10:00:00+02:00", evidence: "mailbox message-id <abc@mail>" });
  ok(again.duplicate && Number((await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message'", [a.id]))!.n) === 1, "re-reporting the same event is idempotent (one activity)");
  await throws(() => S.confirmSend(emp, { event_id: "evt-alpha-2", message_version_id: v2.id, sent_at: "2026-11-08T10:05:00Z", evidence: "again" }), "an authorization cannot be used for a second send");

  console.log("CRM recording failure");
  const b = await mkLead("Beta Cars", "x@beta.test");
  const bv = await S.createVersion(emp, { lead_id: b.id, contact_id: b.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Beta body" });
  await S.authorize(owner, { message_version_id: bv.id, kind: "send", permitted_action: "first_email" });
  S.testHooks.failRecording = 1;
  const pend = await S.confirmSend(emp, { event_id: "evt-beta-1", message_version_id: bv.id, sent_at: "2026-11-08T09:00:00Z", evidence: "msg-id beta" });
  ok(pend.status === "SENT_CONFIRMED_CRM_PENDING" && pend.stop_further_sends === true, "failed recording shows SENT_CONFIRMED_CRM_PENDING and tells the run to stop");
  ok(Number((await one("SELECT COUNT(*) AS n FROM activities WHERE external_id='evt-beta-1'"))!.n) === 0 && (await one("SELECT evidence FROM send_events WHERE event_id='evt-beta-1'"))!.evidence === "msg-id beta", "evidence is durable even though no activity exists yet");
  const el = await S.checkEligibility(emp, bv.id);
  ok(!el.eligible && el.reasons.some((r) => /CRM_PENDING|already|authorization/.test(r)), "no further send to that lead is possible until reconciled");
  const rec = await S.reconcileSend(emp, "evt-beta-1");
  ok(rec.status === "RECORDED", "reconcile records the activity without resending");
  await S.reconcileSend(emp, "evt-beta-1");
  ok(Number((await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message'", [b.id]))!.n) === 1, "reconciling twice still leaves exactly one activity");

  console.log("Restrictions and cross-campaign safety");
  const c = await mkLead("Gamma Cars", "x@gamma.test");
  const cv = await S.createVersion(emp, { lead_id: c.id, contact_id: c.cid, channel: "email", campaign_id: camp, body: "Gamma" });
  await S.authorize(owner, { message_version_id: cv.id, kind: "send", permitted_action: "first_email" });
  await run("UPDATE contacts SET email_status='opted_out' WHERE id=?", [c.cid]);
  const oe = await S.checkEligibility(emp, cv.id);
  ok(!oe.eligible && oe.reasons.some((r) => /opted-out/.test(r)), "an opt-out blocks the send even with a valid authorization");
  await throws(() => S.confirmSend(emp, { event_id: "evt-gamma-1", message_version_id: cv.id, sent_at: "2026-11-08T09:00:00Z", evidence: "nope" }), "confirm refuses and consumes nothing", /opted-out/);
  ok((await one("SELECT status FROM send_authorizations WHERE message_version_id=? AND kind='send'", [cv.id]))!.status === "active", "a refused send leaves the authorization untouched");
  const d = await mkLead("Delta Cars", "x@delta.test");
  await run("INSERT INTO activities (lead_id,type,message_kind,channel,outcome,actor_id,occurred_at,created_at) VALUES (?,'message','first_email','email','sent',?,'2026-06-01T08:00:00.000Z','2026-06-01T08:00:00.000Z')", [d.id, emp.id]);
  const dv = await S.createVersion(emp, { lead_id: d.id, contact_id: d.cid, channel: "email", campaign_id: camp, body: "Delta" });
  await S.authorize(owner, { message_version_id: dv.id, kind: "send", permitted_action: "first_email" });
  ok((await S.checkEligibility(emp, dv.id)).reasons.some((r) => /first email was already sent/.test(r)), "a first email already sent (any date or campaign) blocks another first email");
  await C.enrolLead(chief, d.id, { campaign_id: camp2, transfer_from_campaign_id: camp });
  ok((await S.checkEligibility(emp, dv.id)).reasons.some((r) => /not an active member/.test(r)), "after a transfer the old campaign can no longer send to the lead");
  const m = await mkLead("Meeting Cars", "x@meeting.test", "meeting");
  const mv = await S.createVersion(emp, { lead_id: m.id, contact_id: m.cid, channel: "email", campaign_id: camp, body: "Follow up" });
  await S.authorize(owner, { message_version_id: mv.id, kind: "send", permitted_action: "follow_up" });
  await S.confirmSend(emp, { event_id: "evt-meet-1", message_version_id: mv.id, sent_at: "2026-11-08T09:30:00Z", evidence: "msg-id meet" });
  ok((await one("SELECT stage FROM leads WHERE id=?", [m.id]))!.stage === "meeting", "a send never overrides a stronger stage");

  console.log("Concurrent workers");
  const r = await mkLead("Race Cars", "x@race.test");
  const rvv = await S.createVersion(emp, { lead_id: r.id, contact_id: r.cid, channel: "email", campaign_id: camp, body: "Race" });
  await S.authorize(owner, { message_version_id: rvv.id, kind: "send", permitted_action: "first_email" });
  const res = await Promise.allSettled([1, 2, 3].map((i) => S.confirmSend(emp, { event_id: `evt-race-${i}`, message_version_id: rvv.id, sent_at: "2026-11-08T09:40:00Z", evidence: `race ${i}` })));
  ok(res.filter((x) => x.status === "fulfilled").length === 1 && Number((await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='message'", [r.id]))!.n) === 1, "three simultaneous workers: exactly one send is recorded");
  ok(!(await one("SELECT 1 AS x FROM users WHERE history_import_until IS NOT NULL")) , "normal operation uses no temporary migration permission");
  ok((await S.listSends(owner)).length >= 4 && (await S.listSends(owner, "SENT_CONFIRMED_CRM_PENDING")).length === 0, "send events are listable by status");
  void all;

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
