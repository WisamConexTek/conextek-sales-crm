// Run: npm test   (follow-up sequences: dates, automatic next-step tasks, outcome rules, capacity priority, work plan, backfill, compliance, sorting)
import { rmSync } from "node:fs";
const DB = "data/sequence-test.db";
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
  const IN = await import("../src/lib/service/inbound");
  const CAP = await import("../src/lib/service/capacity");
  const Q = await import("../src/lib/service/sequences");
  const TL = await import("../src/lib/service/tasklist");
  const WP = await import("../src/lib/service/workplan");
  const CO = await import("../src/lib/service/compliance");
  const AW = await import("../src/lib/service/agentwork");
  const A = await import("../src/lib/service/activities");
  const API = await import("../src/lib/api");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const throws = async (fn: () => Promise<unknown>, name: string, re?: RegExp) => { try { await fn(); ok(false, name + " (did not throw)"); } catch (e) { ok(re ? re.test((e as Error).message) : true, name); } };
  const owner = await actorById(1, "api");
  const mkUser = async (username: string, name: string, role: string, preset: string) => {
    const id = (await U.createUser(owner, { username, name, role, preset })).id;
    if (preset === "outreach" || preset === "researcher") await run("UPDATE users SET permissions=json_insert(permissions,'$[#]','leads.view_all') WHERE id=?", [id]);
    return actorById(id, "api");
  };
  const chief = await mkUser("chief", "Chief", "chief", "chief");
  const writer = await mkUser("writer", "Outreach Writer", "employee", "outreach");
  const hunter = await mkUser("hunter", "Lead Hunter", "employee", "researcher");
  const inbox = await mkUser("inbox", "Inbox Manager", "employee", "outreach");
  const li = await mkUser("linkedin", "LinkedIn Manager", "employee", "outreach");
  const coach = await mkUser("coach", "Quality Coach", "employee", "compliance");
  await run("UPDATE campaigns SET status='active'");
  const canton = (await one("SELECT id FROM campaigns WHERE key='canton_fair'"))!.id as number;
  const gulf = (await one("SELECT id FROM campaigns WHERE key='gulf_car_dealers'"))!.id as number;
  const us = (await one("SELECT id FROM campaigns WHERE key='us_car_dealers'"))!.id as number;
  await run("UPDATE senders SET daily_cap=200 WHERE id=1");
  let n = 0;
  const mk = async (company: string, campaign = canton, email?: string) => {
    const id = await L.createLead(owner, { company, stage: "ready", campaign_id: campaign, owner_id: writer.id, contacts: [{ name: `${company} contact`, email: email ?? `c${++n}@${company.toLowerCase().replace(/[^a-z]/g, "")}.test` }] });
    return { id, cid: (await one("SELECT id FROM contacts WHERE lead_id=?", [id]))!.id as number };
  };
  const send = async (lead: { id: number; cid: number }, campaign: number, action: "first_email" | "follow_up", o: { task_id?: number; subject?: string; body?: string; labels?: string[]; noSend?: boolean } = {}) => {
    const v = await S.createVersion(writer, { lead_id: lead.id, contact_id: lead.cid, channel: "email", campaign_id: campaign, subject: o.subject ?? "Your Canton booth", body: o.body ?? `Hello ${lead.id} ${action} ${Math.random()}`, task_id: o.task_id, experiment_labels: o.labels });
    await S.authorize(chief, { message_version_id: v.id, kind: "editorial", permitted_action: action });
    await S.authorize(owner, { message_version_id: v.id, kind: "send", permitted_action: action });
    if (o.noSend) return { v: v.id, r: null as never };
    const r = await S.confirmSend(writer, { event_id: `ev-${v.id}`, message_version_id: v.id, sent_at: new Date(Date.now() - 30000).toISOString(), evidence: `<msg-${v.id}@outlook>` });
    return { v: v.id, r: r as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const today = todayYmd();
  const step = async (key: string, position: number) => (await one("SELECT st.* FROM sequence_steps st JOIN sequences s ON s.id=st.sequence_id WHERE s.key=? AND st.position=? AND st.version=s.version", [key, position]))!;

  console.log("1. Dates (the examples in the request)");
  const W = Q.DEFAULT_WEEKENDS;
  const cf1 = await step("canton_fair_email", 2), cf2 = await step("canton_fair_email", 3), g1 = await step("gulf_car_dealers_email", 2), u2 = await step("us_car_dealers_email", 3), d1 = await step("default_linkedin", 1), d2 = await step("default_linkedin", 2);
  let p = Q.planStep(cf1, "2026-11-16", "2026-11-16", W.china);
  ok(p.due_on === "2026-11-20" && p.window_end_on === "2026-11-23", "Canton E1 Mon 16 Nov: FU1 due Fri 20 Nov, window to Mon 23 Nov");
  p = Q.planStep(cf1, "2026-11-17", "2026-11-17", W.china);
  ok(p.due_on === "2026-11-23" && p.window_end_on === "2026-11-26", "Canton E1 Tue 17 Nov: day 4 is a Saturday, so FU1 is due Mon 23 Nov and the window moves with it");
  p = Q.planStep(g1, "2026-11-16", "2026-11-16", W.gulf);
  ok(p.due_on === "2026-11-22", "Gulf E1 Mon 16 Nov: day 4 is a Friday, so FU1 is due Sun 22 Nov");
  p = Q.planStep(cf2, "2026-11-16", "2026-11-20", W.china);
  ok(p.due_on === "2026-11-27" && p.window_end_on === "2026-11-30", "Canton FU2: E1 + 11 and at least FU1 + 7");
  p = Q.planStep(cf2, "2026-11-16", "2026-11-25", W.china);
  ok(p.due_on === "2026-12-02", "a late FU1 pushes FU2 to FU1 + 7");
  p = Q.planStep(u2, "2026-11-16", "2026-11-20", W.us);
  ok(p.due_on === "2026-11-27" && p.window_end_on === "2026-11-30", "US FU2 is FU1 + 7 with a 3-day window");
  p = Q.planStep(d1, "2026-11-18", "2026-11-18", W.us);
  ok(p.due_on === "2026-11-18" && p.window_end_on === "2026-11-20", "LinkedIn: accepted 18 Nov, DM1 due 18 Nov with the window to 20 Nov");
  p = Q.planStep(d2, "2026-11-19", "2026-11-19", W.us);
  ok(p.due_on === "2026-11-24" && p.window_end_on === "2026-11-26", "LinkedIn: DM1 on 19 Nov, DM2 due 24 Nov with the window to 26 Nov");

  console.log("2. A recorded first email plans the follow-up");
  const a = await mk("Alpha Auto Parts");
  const e1 = await send(a, canton, "first_email", { subject: "Your Canton booth", labels: ["MI-A"] });
  const fu1 = (await one("SELECT * FROM tasks WHERE id=?", [e1.r.sequence.next_task_id]))!;
  const firstOn = todayYmd("Asia/Shanghai", new Date(Date.now() - 30000));
  const want = Q.planStep(cf1, firstOn, firstOn, W.china);
  ok(e1.r.sequence.status === "running" && e1.r.sequence.steps_sent === 1 && fu1, "the answer to POST /sends names the next step and its task");
  ok(fu1.step_code === "FU1" && fu1.step_number === 2 && fu1.step_total === 3 && fu1.due_on === want.due_on && fu1.window_end_on === want.window_end_on, "FU1 is step 2 of 3 with its due date and window");
  ok(fu1.assignee_id === writer.id && fu1.prep_status === "draft_needed" && fu1.auto_generated === 1 && fu1.action_type === "send_follow_up_1", "assigned to the Outreach Writer, draft needed, marked automatic");
  ok(fu1.sender_id === 1 && fu1.thread_subject === "Re: Your Canton booth" && /^FU1 · Alpha Auto Parts · Wisam$/.test(fu1.title) && fu1.labels === '["MI-A"]', "locked to the thread's sender, same subject, short title, experiment labels inherited");
  ok(fu1.message_version_id === null && Number((await one("SELECT COUNT(*) AS n FROM send_authorizations WHERE lead_id=? AND message_version_id<>?", [a.id, e1.v]))!.n) === 0, "the automation created no draft and no authorization");
  await S.confirmSend(writer, { event_id: `ev-${e1.v}`, message_version_id: e1.v, sent_at: new Date(Date.now() - 30000).toISOString(), evidence: "again" });
  await S.reconcileSend(owner, `ev-${e1.v}`);
  await Q.syncEnrollment(owner, a.id, "email");
  ok(Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE lead_id=? AND step_code='FU1'", [a.id]))!.n) === 1, "recording the same send again, or reconciling, creates nothing new");
  const nw = await AW.nextWork(owner, { assignee: "all", kind: "follow_up", limit: 50 });
  ok(nw.items.length === 0 || nw.items.every((i) => i.task.kind === "follow_up"), "GET /work/next?kind=follow_up filters by kind");

  console.log("3. Follow-ups advance the sequence, then the lead rests");
  const f1 = await send(a, canton, "follow_up", { task_id: fu1.id as number, subject: "Re: Your Canton booth" });
  ok((await one("SELECT status FROM tasks WHERE id=?", [fu1.id]))!.status === "completed" && f1.r.sequence.next_step.code === "FU2", "recording FU1 closes its task and plans FU2");
  const fu2 = (await one("SELECT * FROM tasks WHERE id=?", [f1.r.sequence.next_task_id]))!;
  ok(fu2.step_number === 3 && fu2.due_on >= addDays(firstOn, 11) && fu2.due_on >= addDays(firstOn, 7), "FU2 is step 3 of 3, due E1 + 11 and at least FU1 + 7");
  ok((await one("SELECT labels,step_code FROM activities WHERE id=?", [f1.r.activity_id]))!.labels === '["MI-A"]', "the follow-up send carries the experiment labels and its step");
  const f2 = await send(a, canton, "follow_up", { task_id: fu2.id as number, subject: "Re: Your Canton booth" });
  ok(f2.r.sequence.status === "resting" && f2.r.sequence.rest_until === addDays(todayYmd("Asia/Shanghai", new Date(Date.now() - 30000)), 60), "after the last step the lead rests for 60 days");
  const ns = (await L.withNextStep([(await one("SELECT * FROM leads WHERE id=?", [a.id]))!]))[0];
  ok(/^Resting until /.test(ns.next_step.text) && ns.sequence_status === "resting" && ns.emails_sent_count === 3 && ns.last_email_step === "FU2", "the lead shows 'Resting until <date>', 3 emails sent, last step FU2");
  const exp = await CO.experimentReport(owner, { label: "MI" });
  ok(exp.variants.length === 1 && exp.variants[0].variant === "MI-A" && exp.variants[0].sent === 3, "results by label count every step of the variant");

  console.log("4. A reply between approval and send");
  const b = await mk("Bravo Lighting");
  const be1 = await send(b, canton, "first_email");
  const bfu = be1.r.sequence.next_task_id as number;
  const bv = await send(b, canton, "follow_up", { task_id: bfu, noSend: true });
  ok((await S.checkEligibility(owner, bv.v)).eligible, "the approved follow-up is sendable before the reply");
  const rep = await IN.recordReply(inbox, { lead_id: b.id, contact_id: b.cid, received_at: new Date(Date.now() - 5000).toISOString(), message_id: "<r1@bravo>", from: "ops@bravolighting.test", summary: "Tell me more", classification: "interested" });
  const el = await S.checkEligibility(owner, bv.v);
  ok(!el.eligible && el.codes.includes("reply_received"), "eligibility now answers reply_received");
  ok((rep.effects.tasks_cancelled as number[]).includes(bfu) && (rep.effects.sequences_stopped as number[]).length === 1 && Number(rep.effects.send_authorizations_revoked) === 1, "the reply lists its effects: follow-up cancelled, approval withdrawn, sequence stopped");
  const hr = (rep.effects.tasks_created as { kind: string; task_id: number }[]).find((x) => x.kind === "handle_reply")!;
  const hrT = (await one("SELECT * FROM tasks WHERE id=?", [hr.task_id]))!;
  ok(hrT.assignee_id === inbox.id && hrT.due_at && hrT.action_type === "handle_reply" && (await one("SELECT stage FROM leads WHERE id=?", [b.id]))!.stage === "interested", "a Handle reply task goes to the Inbox Manager with a deadline; the stage is Interested");
  await throws(() => S.confirmSend(writer, { event_id: "ev-race", message_version_id: bv.v, sent_at: new Date(Date.now() - 1000).toISOString(), evidence: "<race@outlook>" }), "the follow-up cannot be recorded as sent", /Not sent-eligible/);

  console.log("5. Other reply classes");
  const c = await mk("Charlie Tools");
  const ce1 = await send(c, canton, "first_email");
  await run("UPDATE enrollment_steps SET due_on=?, window_end_on=? WHERE task_id=?", [today, addDays(today, 3), ce1.r.sequence.next_task_id]);
  const back = addDays(today, 5);
  const ooo = await IN.recordReply(inbox, { lead_id: c.id, received_at: new Date(Date.now() - 4000).toISOString(), message_id: "<ooo@charlie>", summary: "Out until next week", classification: "out_of_office", return_date: back });
  ok(ooo.effects.counted_as_reply === false && (ooo.effects.sequences_stopped as number[]).length === 0 && (await one("SELECT status FROM enrollments WHERE lead_id=?", [c.id]))!.status === "running", "out of office does not stop the sequence and is not a reply");
  ok((await one("SELECT due_on FROM tasks WHERE id=?", [ce1.r.sequence.next_task_id]))!.due_on >= addDays(back, 1), "the pending follow-up moves to the day after the return date");
  const auto = await IN.recordReply(inbox, { lead_id: c.id, received_at: new Date(Date.now() - 3000).toISOString(), message_id: "<ticket@charlie>", summary: "Your ticket #123 was received", classification: "auto_reply" });
  ok((await one("SELECT status FROM enrollments WHERE lead_id=?", [c.id]))!.status === "running", "a ticket auto-acknowledgement stops nothing");
  await throws(() => IN.reclassifyReply(writer, auto.activity_id, { classification: "interested", reason: "It was a person" }), "only the Owner, a Chief or the reply handler reclassifies", /reply handler/);
  const rc = await IN.reclassifyReply(inbox, auto.activity_id, { classification: "interested", reason: "It was a person after all" });
  ok((rc.effects.sequences_stopped as number[]).length === 1 && (await one("SELECT type,outcome FROM activities WHERE id=?", [auto.activity_id]))!.type === "reply" && Number((await one("SELECT COUNT(*) AS n FROM reply_classifications WHERE activity_id=?", [auto.activity_id]))!.n) === 2, "reclassifying an auto-reply as interested stops the sequence, lists the effects and keeps the history");
  const dd = await mk("Delta Motors");
  await send(dd, canton, "first_email");
  const ref = await IN.recordReply(inbox, { lead_id: dd.id, contact_id: dd.cid, received_at: new Date(Date.now() - 2000).toISOString(), message_id: "<ref@delta>", summary: "Please contact our manager Mr. Wang", classification: "referral", referred_name: "Mr. Wang", referred_details: "purchasing manager" });
  const refT = (ref.effects.tasks_created as { kind: string; task_id: number }[]).find((x) => x.kind === "add_referred_contact")!;
  ok(refT && (await one("SELECT assignee_id FROM tasks WHERE id=?", [refT.task_id]))!.assignee_id === hunter.id && Number((await one("SELECT COUNT(*) AS n FROM enrollments WHERE lead_id=?", [dd.id]))!.n) === 1 && Number((await one("SELECT COUNT(*) AS n FROM contacts WHERE lead_id=?", [dd.id]))!.n) === 1, "a referral stops the sequence and gives the Lead Hunter a task; nobody is added or enrolled automatically");
  const ee = await mk("Echo Export");
  await send(ee, canton, "first_email");
  const nn = await IN.recordReply(inbox, { lead_id: ee.id, received_at: new Date(Date.now() - 2000).toISOString(), message_id: "<nn@echo>", summary: "Maybe next quarter", classification: "not_now" });
  ok(nn.effects.resting_until === addDays(today, 90) && (await one("SELECT status,rest_until FROM enrollments WHERE lead_id=?", [ee.id]))!.status === "resting", "not now: the lead rests 90 days with a Revisit task");
  const ff = await mk("Foxtrot Freight");
  const fe1 = await send(ff, canton, "first_email");
  const no = await IN.recordReply(inbox, { lead_id: ff.id, contact_id: ff.cid, received_at: new Date(Date.now() - 2000).toISOString(), message_id: "<no@fox>", summary: "No thanks", classification: "not_interested" });
  ok((no.effects.suppression_added as string[]).length >= 1 && (await one("SELECT stage FROM leads WHERE id=?", [ff.id]))!.stage === "lost", "not interested: lost, and the company goes on the suppression list");
  ok((await S.checkEligibility(owner, fe1.v)).codes.includes("suppressed"), "a suppressed address fails eligibility with code suppressed");
  const g = await mk("Golf Gears", canton, "sales@golfgears.test"), g2 = await mk("Golf Gears Trading", canton, "boss@golfgears.test"), g3 = await mk("Gmail One", canton, "one@gmail.com"), g4 = await mk("Gmail Two", canton, "two@gmail.com");
  for (const x of [g, g2, g3, g4]) await send(x, canton, "first_email");
  const gr = await IN.recordReply(inbox, { lead_id: g.id, contact_id: g.cid, received_at: new Date(Date.now() - 1500).toISOString(), message_id: "<g@golf>", from: "sales@golfgears.test", summary: "Send details", classification: "soft" });
  ok((gr.effects.same_company_reviews as { lead_id: number }[])?.[0]?.lead_id === g2.id && (await one("SELECT status FROM enrollments WHERE lead_id=?", [g2.id]))!.status === "running", "same corporate domain on another lead: a review item for the Chief, and nothing stops by itself");
  const gm = await IN.recordReply(inbox, { lead_id: g3.id, contact_id: g3.cid, received_at: new Date(Date.now() - 1500).toISOString(), message_id: "<g@gmail>", from: "one@gmail.com", summary: "Sounds fine", classification: "soft" });
  ok(!gm.effects.same_company_reviews && (await one("SELECT status FROM enrollments WHERE lead_id=?", [g4.id]))!.status === "running", "a free-mail domain is never used to match companies");

  console.log("6. Bounces");
  const h = await mk("Hotel Hardware");
  const he1 = await send(h, canton, "first_email");
  await run("UPDATE enrollment_steps SET due_on=?, window_end_on=? WHERE task_id=?", [today, addDays(today, 3), he1.r.sequence.next_task_id]);
  const sb = await IN.recordBounce(inbox, { contact_id: h.cid, bounced_at: new Date(Date.now() - 1000).toISOString(), reason: "mailbox full", bounce_type: "soft", message_id: "<sb1>" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(sb.counted_as_hard === false && (await one("SELECT email_status FROM contacts WHERE id=?", [h.cid]))!.email_status !== "bounced" && (await one("SELECT due_on FROM tasks WHERE id=?", [he1.r.sequence.next_task_id]))!.due_on >= addDays(today, 3), "a first soft bounce holds the step 3 days and leaves the contact usable");
  const sb2 = await IN.recordBounce(inbox, { contact_id: h.cid, bounced_at: new Date().toISOString(), reason: "mailbox full again", bounce_type: "soft", message_id: "<sb2>" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(sb2.counted_as_hard === true && (await one("SELECT email_status FROM contacts WHERE id=?", [h.cid]))!.email_status === "bounced" && (await one("SELECT status,stop_reason FROM enrollments WHERE lead_id=?", [h.id]))!.status === "stopped", "a second soft bounce counts as hard: contact bounced, sequence stopped");
  ok((sb2.effects.tasks_created as { kind: string }[])[0].kind === "find_contact", "with no other contact the Lead Hunter gets a Find contact task");
  ok((await CAP.capacitySettings()).bounce_limit === 0.02, "the sender pause threshold is 2% by default");

  console.log("7. Capacity priority (the worked examples)");
  const items = (w: number, o: number, l: number, f: number) => [...Array(w).fill("window"), ...Array(o).fill("overdue"), ...Array(l).fill("late"), ...Array(f).fill("first")].map((kind, i) => ({ kind: kind as "window", sort: String(i).padStart(3, "0"), campaign_id: 1 }));
  let al = CAP.allocate(15, 5, 8, items(6, 4, 10, 12), () => 0);
  ok(al.counts.window === 6 && al.counts.overdue === 4 && al.counts.first_floor === 5 && al.counts.late === 0 && al.counts.first === 0 && al.pushed.length === 17, "cap 15: 6 in-window, 4 overdue, 5 first emails (the floor); 10 late items and 7 first emails pushed");
  al = CAP.allocate(25, 5, 8, items(6, 4, 10, 12), () => 0);
  ok(al.counts.late === 8 && al.counts.first === 2 && al.counts.first_floor === 5, "cap 25: 6 + 4 + 5 + 8 late (the limit) + 2 first emails");
  al = CAP.allocate(15, 5, 8, items(13, 0, 0, 6), () => 0);
  ok(al.counts.window === 10 && al.counts.first_floor === 5, "a follow-up backlog never takes the protected first-email slots");
  al = CAP.allocate(15, 5, 8, items(7, 2, 8, 4), () => 0, true);
  ok(al.counts.window === 7 && al.counts.overdue === 2 && al.counts.first_floor === 4 && al.empty_floor === 1 && al.counts.late === 1 && al.free === 0, "work plan, cap 15: 7 + 2 + 5 floor (4 prepared, 1 waiting for a lead) + 1 late");
  al = CAP.allocate(8, 0, 8, items(0, 0, 0, 3), () => 0, true);
  ok(al.counts.first === 3 && al.free === 5, "work plan, Madison cap 8: 3 prepared, 5 slots need a lead");

  console.log("8. Work plan and roles");
  const plan = await WP.workPlan(owner, { date: addDays(today, 1) }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(plan.senders.length >= 1 && plan.views.writer && plan.views.hunter && plan.roles.writer.user_id === writer.id && plan.roles.hunter.user_id === hunter.id, "the full plan has every role's view and maps roles to people");
  const wv = await WP.workPlan(writer, {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(wv.role === "writer" && wv.view.senders, "a role sees its own view without asking");
  await throws(() => WP.workPlan(hunter, { role: "writer" }), "the Lead Hunter cannot read the writer's view", /only read your own/);
  ok(((await WP.workPlan(coach, { role: "writer" })) as Record<string, unknown>).role === "writer", "the compliance monitor may read every view");
  const hv = (await WP.workPlan(hunter, { date: addDays(today, 1) })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(hv.view.needs.length >= 1 && typeof hv.view.total_need === "number", "the Lead Hunter sees how many leads each sender needs");

  console.log("9. Backfill");
  const old = async (company: string, daysAgo: number[], campaign: number | null = canton) => {
    const l = await mk(company, campaign ?? canton);
    if (!campaign) await run("UPDATE lead_campaigns SET status='removed' WHERE lead_id=?", [l.id]);
    for (const dgo of daysAgo) await run("INSERT INTO activities (lead_id,contact_id,type,message_kind,channel,outcome,title,body,actor_id,occurred_at,created_at,is_demo,occurred_precision,sender_id) VALUES (?,?,'message',?,'email','sent','Old subject','x',?,?,?,0,'time',1)", [l.id, l.cid, dgo === daysAgo[0] ? "first_email" : "follow_up", writer.id, new Date(Date.now() - dgo * 86400000).toISOString(), new Date().toISOString()]);
    await run("UPDATE leads SET stage='contacted' WHERE id=?", [l.id]);
    return l;
  };
  const o1 = await old("Old One", [30]), o2 = await old("Old Two", [30, 24]), o3 = await old("Old Three", [1]), o4 = await old("Old NoCampaign", [20], null), o5 = await old("Old Done", [40, 34, 27]);
  const dry = await Q.backfill(chief, { dry_run: true }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const it = (id: number) => dry.items.find((x: { lead_id: number }) => x.lead_id === id);
  ok(it(o1.id).next.code === "FU1" && it(o1.id).state === "late" && it(o2.id).next.code === "FU2" && it(o2.id).state === "late" && it(o3.id).state === "upcoming" && it(o5.id).state === "finished", "the dry run finds the step each lead is on and whether it is late");
  ok(it(o4.id).no_campaign === true && dry.summary.in_no_campaign === 1, "a lead in no campaign is flagged, not skipped");
  ok(Number((await one("SELECT COUNT(*) AS n FROM enrollments WHERE lead_id IN (?,?,?,?,?)", [o1.id, o2.id, o3.id, o4.id, o5.id]))!.n) === 0, "the dry run creates nothing");
  await throws(() => Q.backfill(writer, {}), "only the Owner or a Chief runs the backfill", /Owner or a Chief/);
  const com = await Q.backfill(chief, { dry_run: false, limit: 100 }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const lt = (await one("SELECT * FROM tasks WHERE lead_id=? AND enrollment_id IS NOT NULL", [o2.id]))!;
  ok(com.remaining === 0 && lt.step_code === "FU2" && lt.is_late === 1 && lt.labels === '["LATE"]' && lt.prep_status === "draft_needed", "commit: a late FU2 task, labelled LATE, starting at draft needed");
  ok((await one("SELECT status FROM enrollments WHERE lead_id=?", [o5.id]))!.status === "resting" && Number((await one("SELECT COUNT(*) AS n FROM send_authorizations WHERE lead_id=?", [o2.id]))!.n) === 0, "a finished sequence goes to rest; the backfill authorizes nothing");
  const again = await Q.backfill(chief, { dry_run: false }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok((again.committed ?? 0) === 0 && Number((await one("SELECT COUNT(*) AS n FROM tasks WHERE lead_id=? AND enrollment_id IS NOT NULL", [o2.id]))!.n) === 1, "running it again changes nothing");

  console.log("10. LinkedIn");
  const lk = await mk("Lima Links", us);
  const acc = await A.recordActivity(li, lk.id, { type: "note", channel: "linkedin", title: "Invitation accepted", event: "linkedin_accepted" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const dm1 = (await one("SELECT * FROM tasks WHERE id=?", [acc.sequence.next_task_id]))!;
  ok(dm1.step_code === "DM1" && dm1.assignee_id === li.id && dm1.channel === "linkedin", "an accepted invitation plans DM1 for the LinkedIn Manager");
  const dm = await A.recordActivity(li, lk.id, { type: "message", message_kind: "other", channel: "linkedin", title: "DM 1", body: "Hi there" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(dm.sequence.next_step.code === "DM2" && (await one("SELECT status FROM tasks WHERE id=?", [dm1.id]))!.status === "completed", "a DM recorded by hand closes DM1 and plans DM2");

  console.log("11. Leads list: next step, filters, sorting");
  const nr = await L.listLeads(owner, { outreach: "no_reply", pageSize: 200 });
  ok(!nr.rows.some((r) => r.id === h.id) && !nr.rows.some((r) => r.id === b.id) && nr.rows.some((r) => r.id === o1.id), "outreach=no_reply leaves out bounced leads and leads that replied");
  const asc = await L.listLeads(owner, { sort: "company", pageSize: 5 }), desc = await L.listLeads(owner, { sort: "-company", pageSize: 5 }), desc2 = await L.listLeads(owner, { sort: "-company", pageSize: 5, page: 2 });
  ok(asc.applied_sort === "company" && desc.applied_sort === "-company" && String(desc.rows[0].company) > String(desc.rows[4].company) && String(desc.rows[4].company) >= String(desc2.rows[0].company) && asc.rows[0].id !== desc.rows[0].id, "sort=-company is really descending and page 2 continues it");
  const bad = await L.listLeads(owner, { ...L.leadFiltersFrom((k) => ({ sort: "foobar", outreach: "nope" } as Record<string, string>)[k]) });
  ok(bad.applied_sort === "-last_activity_at" && bad.warnings.length === 2, "an unknown sort or filter value is reported in warnings with the order that was applied");
  const miss = await L.listLeads(owner, { nextStep: "missing", pageSize: 200 });
  ok(!miss.rows.some((r) => r.id === o1.id) && !miss.rows.some((r) => r.id === a.id), "after the backfill no contacted no-reply lead is missing a next step");
  const row1 = (await L.withNextStep([(await one("SELECT * FROM leads WHERE id=?", [o1.id]))!]))[0];
  ok(/^Follow-up email 1 · /.test(row1.next_step.text) && row1.next_step.state === "overdue" && row1.next_step.days_overdue > 0 && row1.first_email_sent_at && row1.sequence_step === "E1", "the next step reads 'Follow-up email 1 · <date> (overdue N days)' with the first-email time");
  ok((await L.listLeads(owner, { sequenceStatus: "resting", pageSize: 200 })).rows.some((r) => r.id === a.id) && (await L.listLeads(owner, { sequenceStep: "E1", sender: 1, label: "LATE", pageSize: 200 })).total === 0, "sequence status, step, sender and label filters work");

  console.log("12. Tasks list");
  const p1 = await TL.listTasksView(owner, { status: "open", pageSize: 5, page: 1, defaultSort: "-days_overdue" }), p2 = await TL.listTasksView(owner, { status: "open", pageSize: 5, page: 2, defaultSort: "-days_overdue" });
  const ids = new Set([...p1.rows, ...p2.rows].map((t) => t.id));
  ok(ids.size === p1.rows.length + p2.rows.length && p1.total >= ids.size && p1.applied_sort === "-days_overdue", "pages never overlap and total is returned");
  ok((p1.rows[0].days_overdue ?? 0) >= (p1.rows[p1.rows.length - 1].days_overdue ?? 0) && p1.rows[0].display_title.length <= 62 && !/—/.test(p1.rows[0].display_title), "most overdue first; short display titles without an em dash");
  const fuOnly = await TL.listTasksView(owner, { status: "open", types: ["FU2"], pageSize: 200 });
  ok(fuOnly.rows.length >= 1 && fuOnly.rows.every((t) => t.display_type === "FU2"), "Type FU2 is a filter and shows the FU2 tasks");
  ok(TL.displayType({ action_type: "send_first_email" }) === "Email 1" && TL.displayType({ action_type: "prepare_first_email_draft" }) === "Email 1 draft" && TL.displayType({ action_type: "validate_service_fit" }) === "Research" && TL.displayType({ task_type: "follow_up_draft" }) === "FU draft" && TL.displayType({ action_type: "send_follow_up_2" }) === "FU2", "types are read from the existing fields");
  ok(TL.displayTitle({ title: "ALREADY SENT 2026-11-08 | CRM VERIFIED | Al Najm Al Saeed Co. Ltd.", company: "Al Najm Al Saeed Co. Ltd.", assignee_name: "Chief" }, "Other", null) === "Other · Al Najm Al Saeed Co. Ltd. · Chief", "a status-log title becomes a short display title; the stored title is untouched");
  const sum = await TL.taskSummary(owner, {});
  const openAll = await TL.listTasksView(owner, { status: "open", pageSize: 200 });
  ok(sum.open === openAll.total && sum.overdue.total === (await TL.listTasksView(owner, { status: "open", due: "overdue", pageSize: 200 })).total && sum.blocked === (await TL.listTasksView(owner, { status: "open", blocked: true, pageSize: 200 })).total, "the chip counts match the table each chip opens");
  ok(sum.overdue.by_assignee.reduce((x, y) => x + y.count, 0) === sum.overdue.total, "overdue is split by employee");

  console.log("13. Compliance monitor");
  const rpt = await CO.complianceReport(coach, null);
  ok(rpt.sections.follow_ups_due_not_sent.some((x) => x.lead_id === o1.id && x.state === "no draft") && rpt.suppression.may_be_incomplete === true, "the monitor reads the report: late follow-ups with their state, and the suppression-completeness flag");
  await throws(() => CO.complianceReport(writer, null), "other employees cannot read it", /compliance monitor/);
  const res = await API.execute(new Request("http://x/api/v1/tasks", { method: "POST" }), { via: "api", method: "POST", path: "/tasks", actor: coach, body: { title: "x" } }, async () => ({ id: 1 }));
  ok(res.status === 403 && res.json.code === "read_only" && Number((await one("SELECT COUNT(*) AS n FROM api_requests WHERE actor_id=? AND status=403", [coach.id]))!.n) === 1, "every write by the monitor is refused with 403 and logged");
  const imp = await CO.importSuppressions(chief, { entries: [{ email: "c1@alphaautoparts.test", kind: "opt_out", source: "local log" }, { domain: "blocked.example", kind: "dnc" }, { email: "not-an-email", kind: "dnc" }] });
  ok(imp.dry_run && imp.added === 2 && imp.invalid.length === 1 && Number((await one("SELECT COUNT(*) AS n FROM suppressions WHERE value='blocked.example'"))!.n) === 0, "the suppression import is a dry run by default and reports matches");
  const imp2 = await CO.importSuppressions(chief, { dry_run: false, entries: [{ domain: "blocked.example", kind: "dnc" }] }), imp3 = await CO.importSuppressions(chief, { dry_run: false, entries: [{ domain: "blocked.example", kind: "dnc" }] });
  ok(imp2.added === 1 && imp3.added === 0 && imp3.already_listed === 1 && (await CO.listSuppressions(coach, {})).last_import_at, "committing is idempotent and the monitor can read the list");

  console.log("14. Changes feed and settings");
  const SE = await import("../src/lib/service/senders");
  ok(!!(await SE.getSender(1)).paused_at, "the hard bounce took Wisam's 7-day bounce rate above 2% and paused the sender");
  await SE.resumeSender(owner, 1, "Test: checked the bounce");
  const ch = await AW.changesSince(owner, { since: new Date(Date.now() - 3600000).toISOString(), limit: 500 });
  const types = new Set(ch.changes.map((x) => x.type));
  ok(types.has("sequence_task_created") && types.has("sequence_stopped") && types.has("reply_reclassified") && types.has("sequence_completed"), "GET /changes reports what the sequences did");
  await throws(() => Q.updateSequence(chief, cf1.sequence_id as number, { rest_days: 30 }), "only the Owner edits a sequence", /Owner/);
  const steps = (await all("SELECT * FROM sequence_steps WHERE sequence_id=? AND version=1 ORDER BY position", [cf1.sequence_id as number])).map((s) => ({ step_code: s.step_code, anchor: s.anchor, offset_start: s.position === 2 ? 6 : s.offset_start, offset_end: s.position === 2 ? 9 : s.offset_end, min_gap_prev: s.min_gap_prev }));
  const upd = await Q.updateSequence(owner, cf1.sequence_id as number, { steps, reason: "Try day 6" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const z = await mk("Zulu Zinc");
  const ze1 = await send(z, canton, "first_email");
  const zOn = todayYmd("Asia/Shanghai", new Date(Date.now() - 30000));
  ok(upd.version === 2 && ze1.r.sequence.next_step.due_on === Q.nextWorkday(addDays(zOn, 6), W.china).ymd && (await one("SELECT sequence_version FROM enrollments WHERE lead_id=?", [g2.id]))!.sequence_version === 1, "changing FU1 to day 6 applies to new leads; leads already enrolled keep their version");
  await Q.controlSequence(chief, z.id, { action: "pause", reason: "Trade fair week" });
  const zv = await send(z, canton, "follow_up", { task_id: ze1.r.sequence.next_task_id, noSend: true });
  ok((await S.checkEligibility(owner, zv.v)).codes.includes("sequence_not_running"), "a paused sequence blocks its follow-up");
  await Q.controlSequence(chief, z.id, { action: "resume", reason: "Back" });
  ok(!(await S.checkEligibility(owner, zv.v)).codes.includes("sequence_not_running"), "resuming lifts the block");

  console.log("15. Skip, restart, a new sequence");
  const sk = await mk("Sierra Steel");
  const se1 = await send(sk, canton, "first_email");
  const skv = await send(sk, canton, "follow_up", { task_id: se1.r.sequence.next_task_id, noSend: true });
  await throws(() => Q.controlSequence(writer, sk.id, { action: "skip", reason: "not allowed" }), "only the Owner or a Chief skips a step", /Owner or a Chief/);
  const skip = await Q.controlSequence(chief, sk.id, { action: "skip", reason: "FU1 text not ready in time" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(skip.skipped === "FU1" && skip.next_step.code === "FU2" && (await one("SELECT status FROM tasks WHERE id=?", [se1.r.sequence.next_task_id]))!.status === "cancelled" && skip.send_authorizations_revoked === 1, "skipping FU1 cancels its task, withdraws its approval and plans FU2");
  ok(!(await S.checkEligibility(owner, skv.v)).eligible && (await one("SELECT step_number,step_total FROM tasks WHERE id=?", [skip.next_task_id]))!.step_number === 3, "the skipped draft can no longer be sent; FU2 is still step 3 of 3");
  await Q.controlSequence(chief, sk.id, { action: "stop", reason: "Wrong contact" });
  const rs = await Q.controlSequence(chief, sk.id, { action: "restart", reason: "Contact confirmed" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(rs.status === "running" && rs.next_step.code === "FU2" && rs.next_task_id && (await one("SELECT status FROM tasks WHERE id=?", [rs.next_task_id]))!.status === "todo", "restarting a stopped sequence plans the step that was left");
  await throws(() => Q.controlSequence(chief, a.id, { action: "restart", reason: "again" }), "a finished sequence cannot be restarted", /nothing left/);
  await throws(() => Q.createSequence(chief, { name: "X", channel: "email", copy_from: cf1.sequence_id }), "only the Owner creates a sequence", /Owner/);
  const ns2 = await Q.createSequence(owner, { name: "Canton Fair, email, 4 steps", channel: "email", campaign_id: canton, copy_from: cf1.sequence_id }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(ns2.status === "draft" && ns2.steps.length === 3, "a new sequence starts as a draft with the copied steps");
  await throws(() => Q.updateSequence(owner, ns2.id, { status: "active" }), "two active sequences for one campaign and channel are refused", /already the active sequence/);
  const four = [...ns2.steps.map((x: Record<string, unknown>) => ({ step_code: x.step_code, anchor: x.anchor, offset_start: x.offset_start, offset_end: x.offset_end, min_gap_prev: x.min_gap_prev })), { step_code: "FU3", anchor: "previous", offset_start: 7, offset_end: 10 }];
  await Q.updateSequence(owner, ns2.id, { steps: four });
  await Q.updateSequence(owner, cf1.sequence_id as number, { status: "retired" });
  await Q.updateSequence(owner, ns2.id, { status: "active" });
  const y = await mk("Yankee Yarn");
  const ye1 = await send(y, canton, "first_email");
  ok((await one("SELECT step_total FROM tasks WHERE id=?", [ye1.r.sequence.next_task_id]))!.step_total === 4 && (await one("SELECT status FROM enrollments WHERE lead_id=?", [g2.id]))!.status === "running", "a new lead follows the 4-step sequence; leads on the retired one carry on");
  const D = await import("../src/lib/service/dashboard");
  const fu = await D.loadFollowUps();
  ok(fu.overdue >= 2 && fu.rows.length >= 1 && typeof fu.noNextStep === "number" && typeof fu.repliesWaiting === "number", "the dashboard counts overdue follow-ups per sender, leads with no next step and replies waiting");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
