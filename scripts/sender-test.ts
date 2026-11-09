// Run: npm test   (release: multiple senders, per-sender capacity and warm-up, deliverability guard, reports by sender)
import { rmSync } from "node:fs";
const DB = "data/sender-test.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:./${DB}`;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";
process.env.APP_TIMEZONE = "Asia/Hebron";

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, all, run, ready, todayYmd, addDays } = await import("../src/lib/db");
  const U = await import("../src/lib/service/users");
  const L = await import("../src/lib/service/leads");
  const C = await import("../src/lib/service/campaigns");
  const S = await import("../src/lib/service/sends");
  const T = await import("../src/lib/service/tasks");
  const IN = await import("../src/lib/service/inbound");
  const CAP = await import("../src/lib/service/capacity");
  const SE = await import("../src/lib/service/senders");
  const R = await import("../src/lib/service/reports");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const throws = async (fn: () => Promise<unknown>, name: string, re?: RegExp) => { try { await fn(); ok(false, name + " (did not throw)"); } catch (e) { ok(re ? re.test((e as Error).message) : true, name); } };
  const owner = await actorById(1, "api");
  const chief = await actorById((await U.createUser(owner, { username: "chief", name: "Chief", role: "chief", preset: "chief" })).id, "api");
  const emp = await actorById((await U.createUser(owner, { username: "out", name: "Outreach", role: "employee", preset: "outreach" })).id, "api");
  const camp = await C.createCampaign(chief, { name: "US Test", status: "active" });
  const camp2 = await C.createCampaign(chief, { name: "China Test", status: "active" });
  const campG = await C.createCampaign(chief, { name: "Gulf Test", status: "active" });
  const mk = async (company: string, email: string, campaign = camp) => {
    const id = await L.createLead(owner, { company, stage: "ready", campaign_id: campaign, owner_id: emp.id, contacts: [{ name: company, email }] });
    return { id, cid: (await one("SELECT id FROM contacts WHERE lead_id=?", [id]))!.id as number };
  };
  const approve = async (vid: number) => { await S.authorize(chief, { message_version_id: vid, kind: "editorial", permitted_action: "first_email" }); await S.authorize(owner, { message_version_id: vid, kind: "send", permitted_action: "first_email" }); };
  const today = todayYmd();
  const sentAct = (lead: number, cid: number, sender: number | null, ago = 1000) => run("INSERT INTO activities (lead_id,contact_id,type,message_kind,channel,outcome,title,body,actor_id,occurred_at,created_at,is_demo,occurred_precision,sender_id) VALUES (?,?,'message','first_email','email','sent','x','x',?,?,?,0,'time',?)", [lead, cid, emp.id, new Date(Date.now() - ago).toISOString(), new Date().toISOString(), sender]);

  console.log("1. Senders");
  const senders = await SE.listSenders();
  const w = senders.find((s) => s.email === "wisam.alaysa@conextek.com")!, m = senders.find((s) => s.email === "madison@conextek.us")!;
  ok(w && m && w.id === 1, "both senders are seeded; Wisam is id 1");
  ok(m.display_name === "Madison Brooks" && m.title === "Business Development Representative" && m.languages.join() === "en", "Madison: BDR, English only");
  ok(w.daily_cap === 10, "Wisam stays 10/day");
  ok(m.warmup.length === 5 && m.warmup[0].from_date === "2026-11-10" && m.warmup[0].daily_cap === 5 && m.warmup[4].daily_cap === 25, "Madison warm-up: 5, 8, 12, 20, then 25");
  ok(SE.capOn(SE.toSender({ ...m, languages: '["en"]', campaign_ids: null, active: 1 } as never), m.warmup, "2026-11-12").cap === 5 && SE.capOn(SE.toSender({ ...m, languages: '["en"]', campaign_ids: null, active: 1 } as never), m.warmup, "2026-11-18").cap === 8 && SE.capOn(SE.toSender({ ...m, languages: '["en"]', campaign_ids: null, active: 1 } as never), m.warmup, "2026-12-09").cap === 25 && SE.capOn(SE.toSender({ ...m, languages: '["en"]', campaign_ids: null, active: 1 } as never), m.warmup, "2026-11-09").cap === 0, "caps by date (0 before the first step)");
  await throws(() => SE.updateSender(chief, m.id, { active: false }), "only the Owner changes senders", /Owner/);
  await throws(() => SE.createSender(chief, { email: "x@y.com", display_name: "X" }), "only the Owner adds senders", /Owner/);
  await throws(() => SE.createSender(owner, { email: "madison@conextek.us", display_name: "Dup" }), "duplicate sender email is refused", /exists/);
  await throws(() => SE.setWarmup(chief, m.id, { steps: [] }), "only the Owner edits the warm-up", /Owner/);
  ok((await one("SELECT COUNT(*) AS n FROM message_versions WHERE sender_id<>1"))!.n === 0, "no existing version was moved off the default sender");

  console.log("2. Sender on versions and sends");
  const a = await mk("Alpha", "a@alpha.test");
  const v1 = await S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, subject: "Hello", body: "Hello there" });
  ok((await one("SELECT sender_id,language FROM message_versions WHERE id=?", [v1.id]))!.sender_id === 1, "a version defaults to the Wisam sender");
  ok((await one("SELECT language FROM message_versions WHERE id=?", [v1.id]))!.language === "en", "language is detected and stored");
  const v1m = await S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, subject: "Hello", body: "Hello there", sender_email: "madison@conextek.us" });
  ok(v1m.created && (await one("SELECT sender_id FROM message_versions WHERE id=?", [v1m.id]))!.sender_id === m.id, "same text for another sender is a new version with that sender");
  ok((await S.listVersions(owner, { sender_id: m.id })).length === 1, "versions can be filtered by sender");
  const edited = await S.editVersion(owner, v1m.id, { body: "Hello there, edited" });
  ok((await one("SELECT sender_id FROM message_versions WHERE id=?", [edited.new_version_id]))!.sender_id === m.id, "an edit keeps the sender");
  await throws(() => S.createVersion(emp, { lead_id: a.id, contact_id: a.cid, channel: "email", campaign_id: camp, body: "x", sender_id: 99 }), "an unknown sender is refused", /unknown sender/);

  console.log("3. Eligibility");
  const b = await mk("Beta", "b@beta.test");
  const ar = await S.createVersion(emp, { lead_id: b.id, contact_id: b.cid, channel: "email", campaign_id: camp, subject: "مرحبا", body: "مرحبا بكم، نود أن نعرض عليكم خدماتنا في مجال السيارات", sender_id: m.id });
  await approve(ar.id);
  let el = await S.checkEligibility(owner, ar.id);
  ok(el.codes.includes("sender_language_mismatch"), "an Arabic version assigned to Madison: sender_language_mismatch");
  const arW = await S.createVersion(emp, { lead_id: b.id, contact_id: b.cid, channel: "email", campaign_id: camp, subject: "مرحبا", body: "مرحبا بكم، نود أن نعرض عليكم خدماتنا في مجال السيارات", sender_id: w.id });
  await approve(arW.id);
  ok(!(await S.checkEligibility(owner, arW.id)).codes.includes("sender_language_mismatch"), "the same Arabic version from Wisam is fine");
  await SE.updateSender(owner, m.id, { active: false });
  const c = await mk("Gamma", "c@gamma.test");
  const cv = await S.createVersion(emp, { lead_id: c.id, contact_id: c.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Hi from Madison", sender_id: m.id });
  await approve(cv.id);
  ok((await S.checkEligibility(owner, cv.id)).codes.includes("sender_inactive"), "an inactive sender: sender_inactive");
  await SE.updateSender(owner, m.id, { active: true });
  await SE.updateSender(owner, m.id, { campaign_ids: [camp2] });
  ok((await S.checkEligibility(owner, cv.id)).codes.includes("sender_campaign_not_allowed"), "a campaign the sender may not serve: sender_campaign_not_allowed");
  await SE.updateSender(owner, m.id, { campaign_ids: [camp, camp2] });
  // thread: lead already contacted by Wisam
  await sentAct(c.id, c.cid, null);
  ok((await S.checkEligibility(owner, cv.id)).codes.includes("sender_thread_mismatch"), "a lead already written to by Wisam: sender_thread_mismatch for Madison");
  const cw = await S.createVersion(emp, { lead_id: c.id, contact_id: c.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Hi again from Wisam", sender_id: w.id });
  await S.authorize(chief, { message_version_id: cw.id, kind: "editorial", permitted_action: "follow_up" });
  await S.authorize(owner, { message_version_id: cw.id, kind: "send", permitted_action: "follow_up" });
  ok(!(await S.checkEligibility(owner, cw.id)).codes.includes("sender_thread_mismatch"), "follow-up from the same sender passes the thread rule");
  const cdef = await S.createVersion(emp, { lead_id: c.id, contact_id: c.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "third touch" });
  ok((await one("SELECT sender_id FROM message_versions WHERE id=?", [cdef.id]))!.sender_id === w.id, "a new version in the thread inherits the thread's sender");

  console.log("4. Per-sender capacity and warm-up");
  await SE.setWarmup(owner, m.id, { steps: [{ from_date: today, daily_cap: 2 }, { from_date: addDays(today, 7), daily_cap: 4 }] });
  const d = await mk("Delta", "d@delta.test");
  const dv = await S.createVersion(emp, { lead_id: d.id, contact_id: d.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Delta hello", sender_id: m.id });
  await approve(dv.id);
  ok((await S.checkEligibility(owner, dv.id)).eligible, "under Madison's cap: eligible");
  await sentAct(d.id, d.cid, m.id);
  await sentAct(d.id, d.cid, m.id, 2000);
  const e1 = await mk("Eps", "e@eps.test");
  const ev = await S.createVersion(emp, { lead_id: e1.id, contact_id: e1.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Eps hello", sender_id: m.id });
  await approve(ev.id);
  el = await S.checkEligibility(owner, ev.id);
  ok(el.codes.includes("daily_cap_reached") && /madison@conextek\.us/.test(el.reasons.join()), "Madison at her cap: daily_cap_reached naming the sender");
  const wv = await S.createVersion(emp, { lead_id: e1.id, contact_id: e1.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Eps hello W", sender_id: w.id });
  await approve(wv.id);
  ok(!(await S.checkEligibility(owner, wv.id)).codes.includes("daily_cap_reached"), "Wisam is not blocked by Madison's cap");
  const cap = await CAP.capacityFor();
  const cm = cap.senders.find((x) => x.sender_id === m.id)!, cw_ = cap.senders.find((x) => x.sender_id === w.id)!;
  ok(cm.daily_cap === 2 && cm.used === 2 && cm.remaining === 0 && cm.cap_reached, "capacity: Madison used 2 of 2");
  ok(cw_.daily_cap === 10 && cw_.used === 1, "capacity: Wisam used 1 of 10 (the earlier send)");
  ok(cap.timezone === "Asia/Hebron" && cm.campaigns.length > 0 && cap.campaigns.length >= 3, "capacity is per sender and per campaign, in Asia/Hebron");

  console.log("5. Campaign priority reserves first; the rest is pushed");
  await CAP.setCapacitySettings(owner, { priority: [camp2, camp, campG] });
  await SE.updateSender(owner, w.id, { daily_cap: 3 });
  const created: { lead: number; v: number; camp: number }[] = [];
  for (const [i, cc] of [[1, camp], [2, camp], [3, camp2], [4, camp2]] as [number, number][]) {
    const l = await mk(`Prio${i}`, `p${i}@prio.test`, cc);
    const v = await S.createVersion(emp, { lead_id: l.id, contact_id: l.cid, channel: "email", campaign_id: cc, subject: "P", body: `Prio ${i}`, sender_id: w.id });
    await approve(v.id);
    await T.createTask(owner, { lead_id: l.id, assignee_id: emp.id, title: `Send ${i}`, action_type: "first_email", channel: "email", campaign_id: cc, due_at: today });
    const tk = await one("SELECT id FROM tasks WHERE lead_id=? ORDER BY id DESC LIMIT 1", [l.id]);
    await run("UPDATE message_versions SET task_id=task_id WHERE 0");
    await run("UPDATE tasks SET message_version_id=? WHERE id=?", [v.id, tk!.id]);
    created.push({ lead: l.id, v: v.id, camp: cc });
  }
  // Wisam has 3/day and has sent 1 today => 2 left for 4 candidates: the two China ones reserve first
  const cap2 = await CAP.capacityFor();
  const sw = cap2.senders.find((x) => x.sender_id === w.id)!;
  ok(sw.reserved === 2 && sw.pushed_to_next_day.length === 2, "2 reserved, 2 pushed to the next day");
  ok(sw.campaigns.find((x) => x.campaign_id === camp2)!.reserved === 2 && sw.campaigns.find((x) => x.campaign_id === camp)!.pushed_to_next_day === 2, "the higher-priority campaign reserved first; the lower one was pushed");
  ok(cap2.pushed_to_next_day.length === 2 && cap2.pushed_to_next_day.every((p) => p.campaign_id === camp), "the report lists what was pushed");
  ok(!(await S.checkEligibility(owner, created[2].v)).codes.includes("daily_cap_reached"), "the high-priority send is eligible");
  const pushedEl = await S.checkEligibility(owner, created[0].v);
  ok(pushedEl.codes.includes("daily_cap_reached") && /higher-priority/.test(pushedEl.reasons.join()), "the pushed send is blocked with daily_cap_reached (higher-priority campaigns)");
  await SE.updateSender(owner, w.id, { daily_cap: 10 });

  console.log("6. Deliverability guard");
  const f = await mk("Foxtrot", "f@fox.test");
  // Madison: 2 sends today (above). A bounce makes 1/2 = 50% => auto-pause
  const bres = await IN.recordBounce(owner, { contact_id: d.cid, bounced_at: new Date().toISOString(), reason: "mailbox full" });
  ok(bres.sender_id === m.id, "the bounce is charged to the sender of the message");
  ok((bres as { sender_paused?: boolean }).sender_paused === true, "bounce rate above 3% pauses the sender automatically");
  const mp = await SE.getSender(m.id);
  ok(mp.paused_at && mp.pause_kind === "auto" && /bounce rate/.test(mp.pause_reason ?? ""), "pause is recorded with the reason");
  ok((await one("SELECT COUNT(*) AS n FROM sender_events WHERE sender_id=? AND action='paused' AND auto=1", [m.id]))!.n === 1, "the pause is logged");
  const fv = await S.createVersion(emp, { lead_id: f.id, contact_id: f.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Fox hello", sender_id: m.id });
  await approve(fv.id);
  await SE.setWarmup(owner, m.id, { steps: [{ from_date: today, daily_cap: 50 }] });
  ok((await S.checkEligibility(owner, fv.id)).codes.includes("sender_paused_deliverability"), "paused sender: sender_paused_deliverability");
  const wf = await S.createVersion(emp, { lead_id: f.id, contact_id: f.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Fox hello W", sender_id: w.id });
  await approve(wf.id);
  ok(!(await S.checkEligibility(owner, wf.id)).codes.includes("sender_paused_deliverability"), "Wisam's sends are unaffected");
  await throws(() => SE.resumeSender(chief, m.id, "ok"), "only the Owner resumes", /Owner/);
  await throws(() => SE.resumeSender(owner, m.id, ""), "a reason is required to resume", /reason/);
  await SE.resumeSender(owner, m.id, "Checked the list, bounce was a full mailbox");
  ok(!(await SE.getSender(m.id)).paused_at && !(await S.checkEligibility(owner, fv.id)).codes.includes("sender_paused_deliverability"), "after resume the sender can send again");
  ok((await one("SELECT COUNT(*) AS n FROM sender_events WHERE sender_id=? AND action='resumed' AND reason LIKE 'Checked%'", [m.id]))!.n === 1, "the resume is logged with who and why");
  // the same old bounce does not re-pause after the Owner resumed
  await sentAct(f.id, f.cid, m.id, 500);
  ok(!(await SE.evaluateDeliverability(owner, m.id)).paused, "events before the resume do not re-pause the sender");
  const g = await mk("Golf", "g@golf.test");
  const cr = await SE.recordComplaint(owner, { sender_id: m.id, lead_id: g.id, contact_id: g.cid, message_id: "<spam1@x>" }, L.assertLeadAccess);
  ok(cr.sender_paused === true && (await SE.getSender(m.id)).pause_kind === "auto", "any spam complaint pauses the sender");
  ok((await SE.recordComplaint(owner, { sender_id: m.id, lead_id: g.id, message_id: "<spam1@x>" }, L.assertLeadAccess) as { duplicate: boolean }).duplicate, "the same complaint is de-duplicated");
  ok((await one("SELECT email_status FROM contacts WHERE id=?", [g.cid]))!.email_status === "opted_out", "the complaining contact is blocked");
  await SE.resumeSender(owner, m.id, "Complaint reviewed, list cleaned");
  await SE.pauseSender(owner, m.id, "Manual pause for the weekend");
  const gv = await S.createVersion(emp, { lead_id: f.id, contact_id: f.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Fox 2", sender_id: m.id });
  await approve(gv.id);
  ok((await S.checkEligibility(owner, gv.id)).codes.includes("sender_paused_deliverability") && (await SE.getSender(m.id)).pause_kind === "manual", "the Owner can pause a sender by hand");
  await SE.resumeSender(owner, m.id, "weekend over");

  console.log("7. Senders health");
  const h = await SE.sendersHealth();
  const hm = h.find((x) => x.sender_id === m.id)!;
  ok(h.length === 2 && hm.sent_7d >= 2 && hm.bounces_7d === 1 && hm.complaints_7d === 1 && hm.used_today >= 2, "health shows used today, 7-day sent, bounces, complaints");
  ok(hm.daily_cap === 50 && ["active", "warming_up", "paused"].includes(hm.status), "health shows cap and status");

  console.log("8. Real send records its sender");
  await SE.setWarmup(owner, m.id, { steps: [] });
  await SE.updateSender(owner, m.id, { daily_cap: 100 });
  const hh = await mk("Hotel", "h@hotel.test");
  const hv = await S.createVersion(emp, { lead_id: hh.id, contact_id: hh.cid, channel: "email", campaign_id: camp, subject: "Hi", body: "Hotel hello", sender_id: m.id });
  await approve(hv.id);
  await S.confirmSend(owner, { event_id: "evt-sender-1", message_version_id: hv.id, sent_at: new Date(Date.now() - 60000).toISOString(), evidence: "msg-id <abc@x>" });
  ok((await one("SELECT sender_id FROM send_events WHERE event_id='evt-sender-1'"))!.sender_id === m.id, "the send event has the sender");
  ok((await one("SELECT a.sender_id FROM activities a JOIN send_events e ON e.activity_id=a.id WHERE e.event_id='evt-sender-1'"))!.sender_id === m.id, "the recorded activity has the sender");

  console.log("9. Reports by sender");
  const from = today, to = today;
  const all_ = await R.reportApi(owner, { from, to });
  const bs = (all_ as { by_sender: { sender_id: number; first_emails: number }[] }).by_sender;
  ok(bs.length === 2 && bs.find((x) => x.sender_id === m.id)!.first_emails >= 1 && bs.find((x) => x.sender_id === w.id)!.first_emails >= 1, "the report splits first emails by sender");
  const onlyM = await R.reportApi(owner, { from, to, sender: "madison@conextek.us" }) as { totals: { first_emails: number; leads_added: number }; by_sender: unknown[] };
  const tw = (all_ as { totals: { first_emails: number } }).totals.first_emails;
  ok(onlyM.totals.first_emails < tw && onlyM.totals.first_emails === bs.find((x) => x.sender_id === m.id)!.first_emails && onlyM.by_sender.length === 1, "filtering by sender shows only that mailbox");
  ok(onlyM.totals.leads_added === 0, "non-message numbers are left out under a sender filter");
  const period = await R.reportApi(owner, { period: "week", sender: String(m.id) }) as { by_sender: unknown[] };
  ok(period.by_sender.length === 1, "daily/weekly/monthly views take the sender filter too");
  await throws(() => R.reportApi(owner, { from, to, sender: "nobody@x.com" }), "an unknown sender filter is refused", /sender/);
  const SC = await import("../src/lib/service/schedule");
  const cr2 = await SC.campaignReport(owner, camp);
  ok(cr2.campaigns[0].by_sender.length >= 2, "campaign stats split by sender");
  const cr3 = await SC.campaignReport(owner, camp, m.id);
  ok(cr3.campaigns[0].first_emails < cr2.campaigns[0].first_emails, "campaign stats can be filtered by sender");
  void all;

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
