// Run: npm test   (uses a throwaway database)
import { rmSync } from "node:fs";
rmSync("data/test.db", { force: true });
process.env.DATABASE_URL = "file:./data/test.db";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, ready } = await import("../src/lib/db");
  const U = await import("../src/lib/service/users");
  const L = await import("../src/lib/service/leads");
  const A = await import("../src/lib/service/activities");
  const T = await import("../src/lib/service/tasks");
  const R = await import("../src/lib/service/reports");
  await ready();

  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const throws = async (fn: () => Promise<unknown>, status: number, name: string) => {
    try { await fn(); ok(false, name + " (did not throw)"); }
    catch (e) { ok((e as { status?: number }).status === status, `${name} → ${status}${(e as { status?: number }).status === status ? "" : " got " + (e as Error).message}`); }
  };

  const owner = await actorById(1);
  ok(owner.role === "owner", "owner bootstrapped from env");
  await throws(() => U.createUser({ ...owner, role: "employee", perms: new Set() } as typeof owner, { username: "x", name: "x", role: "employee" }), 403, "employees cannot add users");
  const c = await U.createUser(owner, { username: "chief", name: "Chief", role: "chief" });
  const e1 = await U.createUser(owner, { username: "sara", name: "Sara", role: "employee", preset: "researcher" });
  const e2 = await U.createUser(owner, { username: "omar", name: "Omar", role: "employee", preset: "outreach" });
  const chief = await actorById(c.id, "api"), sara = await actorById(e1.id, "api"), omar = await actorById(e2.id, "api");
  const nu = await U.createUser(chief, { username: "newbie", name: "Newbie", role: "employee", preset: "outreach", password: "chosen-by-chief-1" });
  ok(nu.password === "chosen-by-chief-1", "chief creates an employee with a chosen password");
  ok(!(await actorById(nu.id)).mustChangePassword, "new account is not forced to change password");
  await throws(() => U.createUser(chief, { username: "chief2", name: "C2", role: "chief" }), 403, "chief cannot create another chief");
  await throws(() => U.createUser(chief, { username: "xtest1", name: "x", role: "employee", preset: "chief" }), 403, "chief cannot use the chief preset");
  await throws(() => U.createUser(chief, { username: "xtest2", name: "x", role: "employee", password: "short" }), 400, "short password rejected");
  await throws(() => U.createUser(chief, { username: "newbie", name: "dup", role: "employee" }), 409, "duplicate username rejected");
  ok(!(await actorById(nu.id)).perms.has("approvals.decide"), "chief-created employee has no approval rights");

  console.log("Leads & duplicates");
  const lid = await L.createLead(sara, { company: "Acme Ltd", website: "https://www.acme.com/about", country: "UAE", contacts: [{ name: "Jo", email: "jo@acme.com" }] });
  ok(lid > 0, "researcher creates lead");
  await throws(() => L.createLead(sara, { company: "ACME ltd" }), 409, "duplicate company blocked");
  await throws(() => L.createLead(sara, { company: "Other", website: "acme.com" }), 409, "duplicate domain blocked");
  await throws(() => L.createLead(sara, { company: "Other2", contacts: [{ name: "x", email: "JO@acme.com" }] }), 409, "duplicate email blocked");
  await throws(() => L.createLead(omar, { company: "Nope" }), 403, "outreach preset cannot create leads");
  await throws(() => L.getLead(omar, lid), 404, "employee cannot see another employee's lead");
  await L.updateLead(chief, lid, { owner_id: omar.id });
  ok((await L.getLead(omar, lid)).lead.owner_id === omar.id, "chief reassigns lead; new owner sees it");
  await throws(() => L.updateLead(omar, lid, { owner_id: sara.id }), 403, "employee cannot reassign");

  console.log("Stage changes");
  await throws(() => L.setStage(omar, lid, "contacted", ""), 400, "stage change needs a reason");
  await throws(() => L.setStage(omar, lid, "bogus", "because"), 400, "unknown stage rejected");
  await L.setStage(omar, lid, "researching", "Started research");
  ok((await L.getLead(omar, lid)).lead.stage === "researching", "stage updated");

  console.log("Messages, bounces, replies");
  const contactId = (await L.getLead(omar, lid)).contacts[0].id;
  await throws(() => A.recordActivity(sara, lid, { type: "message", message_kind: "first_email", body: "x" }), 404, "non-owner can't touch lead");
  const s1 = await A.recordActivity(omar, lid, { type: "message", message_kind: "first_email", title: "Hi", body: "Hello", contact_id: contactId, ref: "msg-1" });
  const s2 = await A.recordActivity(omar, lid, { type: "message", message_kind: "follow_up", body: "Following up", contact_id: contactId });
  await throws(() => A.recordActivity(omar, lid, { type: "message", message_kind: "first_email", body: "x", occurred_at: new Date(Date.now() + 86400000).toISOString() }), 400, "cannot record future sends");
  await throws(() => A.recordActivity(omar, lid, { type: "message", body: "x" }), 400, "message needs kind");
  await A.recordActivity(omar, lid, { type: "outcome", outcome: "bounced", parent_id: s1.id });
  await throws(() => A.recordActivity(omar, lid, { type: "outcome", outcome: "bounced", parent_id: s1.id }), 409, "double bounce blocked");
  ok((await L.getLead(omar, lid)).contacts[0].email_status === "bounced", "bounce flags contact");
  const w = await A.recordActivity(omar, lid, { type: "message", message_kind: "follow_up", body: "again", contact_id: contactId });
  ok(w.warnings.length === 1, "warns when sending to bounced contact");
  await A.recordActivity(omar, lid, { type: "reply", body: "Thanks, interested", contact_id: contactId });
  await A.recordActivity(omar, lid, { type: "research", title: "Found a site", body: "..." });
  await throws(() => A.recordActivity(sara, lid, { type: "note", body: "hi" }), 404, "scope enforced on activities");

  const rep = await R.getReport(owner, { granularity: "day" });
  ok(rep.totals.first_emails === 1 && rep.totals.first_email_bounces === 1, "first-email bounce counted (1/1)");
  ok(rep.totals.follow_ups === 2 && rep.totals.follow_up_bounces === 0, "follow-ups counted separately (2, 0 bounces)");
  ok(rep.totals.replies === 1, "reply counted");
  ok(rep.totals.leads_added === 1, "leads added counted");
  ok(R.rate(rep.totals.first_email_bounces, rep.totals.first_emails) === 1, "first-email bounce rate = 100%");
  const dash = await R.getDashboard(owner, {});
  ok(dash.firstBounceRate === 1 && dash.followBounceRate === 0, "dashboard rates match");
  ok(dash.byStage.find((s) => s.key === "researching")?.n === 1, "leads by stage");
  const own = await R.getReport(omar, { granularity: "day", employee: sara.id });
  ok(own.employee === omar.id, "employee report forced to self");

  console.log("Tasks & approvals");
  const t1 = await T.createTask(chief, { title: "Draft first email", lead_id: lid, assignee_id: omar.id, task_type: "first_email_draft", due_at: new Date(Date.now() - 3600000).toISOString() });
  ok((await T.getTask(omar, t1)).approval_from === "chief", "draft type defaults to Chief approval");
  const tp = await T.createTask(chief, { title: "Pricing offer", lead_id: lid, assignee_id: omar.id, task_type: "pricing_offer", approval: "chief" });
  ok((await T.getTask(omar, tp)).approval_from === "wisam", "Chief cannot lower a Wisam-only type to Chief");
  await throws(() => T.createTask(omar, { title: "x", assignee_id: sara.id }), 403, "employee cannot assign to others");
  await throws(() => T.completeTask(omar, t1), 400, "cannot complete before approval");
  ok((await T.listTasks(sara, {})).length === 0, "employee only sees own tasks");
  ok((await T.listTasks(owner, { overdue: true })).length === 1, "overdue detected");
  await T.updateTask(omar, t1, { status: "in_progress", progress_note: "working" });
  const ap1 = await T.submitTask(omar, t1, { kind: "draft", content: "Subject: Hello\n\nBody" });
  ok((await T.getTask(omar, t1)).status === "waiting_approval", "task waits for approval");
  await throws(() => T.decideApproval(omar, ap1, { decision: "approved" }), 403, "employee cannot approve");
  await throws(() => T.decideApproval(chief, ap1, { decision: "changes_requested" }), 400, "changes need a comment");
  await T.decideApproval(chief, ap1, { decision: "changes_requested", comment: "Shorter please" });
  const tt = await T.getTask(omar, t1);
  ok(tt.status === "changes_requested" && tt.change_request === "Shorter please", "changes requested visible to employee");
  const ap2 = await T.submitTask(omar, t1, { kind: "draft", content: "Subject: Hi\n\nShort" });
  await T.decideApproval(chief, ap2, { decision: "approved", comment: "ok" });
  ok((await T.getTask(omar, t1)).status === "approved", "approved");
  ok((await one("SELECT COUNT(*) n FROM activities WHERE lead_id=? AND type='message'", [lid]))!.n === 3, "approving did NOT create a sent message");
  await T.completeTask(omar, t1, "Sent via mailbox");
  ok((await T.getTask(omar, t1)).status === "completed", "completes after approval");

  const apw = await T.submitTask(omar, tp, { kind: "other", content: "Offer: $500/mo" });
  await throws(() => T.decideApproval(chief, apw, { decision: "approved" }), 403, "Chief cannot decide Wisam-only item");
  const dash2 = await R.getDashboard(owner, {});
  ok(dash2.pending.wisam === 1 && dash2.pending.chief === 0, "dashboard shows pending Wisam");
  await T.decideApproval(owner, apw, { decision: "approved" });
  ok(true, "Owner decides Wisam item");

  const tc = await T.createTask(chief, { title: "Chief's own research", assignee_id: chief.id, task_type: "research" });
  const apc = await T.submitTask(chief, tc, { kind: "findings", content: "Findings here" });
  await throws(() => T.decideApproval(chief, apc, { decision: "approved" }), 403, "Chief cannot approve own submission (routed to Wisam)");

  console.log("Permissions & access");
  await U.setPermissions(chief, e1.id, ["leads.create", "approvals.decide"]);
  const sara2 = await actorById(e1.id);
  ok(!sara2.perms.has("approvals.decide"), "Chief cannot grant approval authority");
  ok(sara2.perms.has("leads.create"), "Chief can grant allowed permission");
  await U.updateUserProfile(owner, e1.id, { active: false });
  const k = await U.createKey(owner, e2.id, "bot");
  ok(k.startsWith("ctk_"), "api key issued");
  await throws(() => U.createKey(omar, e2.id, "x"), 403, "employee cannot create API keys");
  const { getApiActor } = await import("../src/lib/auth");
  ok((await getApiActor(new Request("http://x", { headers: { authorization: `Bearer ${k}` } }))).id === omar.id, "api key authenticates as employee");
  await throws(() => getApiActor(new Request("http://x", { headers: { authorization: "Bearer nope" } })), 401, "bad key rejected");
  const keys = await U.listKeys(omar.id);
  await U.revokeKey(owner, keys[0].id as number);
  await throws(() => getApiActor(new Request("http://x", { headers: { authorization: `Bearer ${k}` } })), 401, "revoked key rejected");
  const pw = await U.resetPassword(owner, e2.id);
  ok(pw.length >= 12, "reset without a password generates one");
  ok(!(await actorById(e2.id)).mustChangePassword, "no forced password change");
  await U.resetPassword(owner, e2.id, "my-own-chosen-pass");
  await throws(() => U.resetPassword(owner, e2.id, "short"), 400, "short password rejected");

  console.log("Demo data exclusion");
  const dl = await L.createLead(owner, { company: "DEMO Co", owner_id: omar.id }, true);
  await A.recordActivity(omar, dl, { type: "message", message_kind: "first_email", body: "demo" });
  const rep2 = await R.getReport(owner, { granularity: "day" });
  ok(rep2.totals.first_emails === 1 && rep2.totals.leads_added === 1, "demo records excluded from reports");
  ok((await L.listLeads(owner, {})).total === 1 && (await L.listLeads(owner, { includeDemo: true })).total === 2, "demo hidden from lists by default");

  console.log("Test data flag");
  const real1 = (await R.getReport(owner, { granularity: "day" })).totals;
  const tl = await L.createLead(chief, { company: "Test Lead Inc", website: "https://testlead.example", is_test: true, owner_id: omar.id });
  ok((await L.getLead(chief, tl)).lead.is_demo === 1, "lead created with is_test is flagged");
  const tlt = await T.createTask(chief, { title: "Test task", lead_id: tl, assignee_id: omar.id, task_type: "research" });
  ok((await T.getTask(omar, tlt)).is_demo === 1, "task on a test lead is test data");
  await A.recordActivity(omar, tl, { type: "research", title: "Test research", body: "x" });
  const tsub = await T.submitTask(omar, tlt, { kind: "findings", content: "test findings" });
  ok((await T.listApprovals(chief, { includeDemo: true, id: tsub }))[0].is_demo === 1, "approval on a test lead is test data");
  const real2 = (await R.getReport(owner, { granularity: "day" })).totals;
  ok(JSON.stringify(real1) === JSON.stringify(real2), "test lead, task and work are not counted in report totals");
  ok((await R.getDashboard(owner, {})).pending.chief === 0, "test approvals are not counted on the dashboard");
  await throws(() => T.createTask(chief, { title: "x", lead_id: lid, assignee_id: omar.id, is_test: true }), 400, "cannot create a test task on a real lead");
  await throws(() => L.setLeadTest(omar, lid, true), 403, "employee cannot flag test data");
  await L.setLeadTest(chief, lid, true);
  ok((await one("SELECT COUNT(*) n FROM activities WHERE lead_id=? AND is_demo=0", [lid]))!.n === 0 && (await T.getTask(omar, t1)).is_demo === 1, "marking a lead as test flags its history and tasks");
  const real3 = (await R.getReport(owner, { granularity: "day" })).totals;
  ok(real3.first_emails === 0, "flagged lead drops out of report totals");
  await L.setLeadTest(chief, lid, false);
  ok(JSON.stringify((await R.getReport(owner, { granularity: "day" })).totals) === JSON.stringify(real2), "marking it real restores the totals");

  console.log("Progress notes, completion actor, approval actors");
  const tn = await T.createTask(chief, { title: "Notes task", lead_id: lid, assignee_id: omar.id, approval: "none" });
  await T.updateTask(omar, tn, { status: "in_progress", progress_note: "first note" });
  await T.updateTask(omar, tn, { progress_note: "second note" });
  await T.completeTask(omar, tn, "all done");
  const dn = await T.getTaskDetail(omar, tn);
  ok(dn.notes.length === 3 && dn.notes.map((n) => n.kind).join() === "progress,progress,completion", "earlier progress notes are kept after completion");
  ok(dn.progress_note === "second note" && dn.completion_note === "all done", "completion note does not overwrite progress");
  ok(dn.completed_by === omar.id && dn.completed_by_name === omar.name && !!dn.completed_at, "completion actor and time recorded");
  ok(dn.timeline.some((e) => e.event === "completed" && e.actor === omar.name), "timeline shows who completed");
  const d1 = await T.getTaskDetail(omar, t1);
  const decided = d1.approvals.find((a) => a.status === "approved")!;
  ok(decided.decided_by_name === chief.name && !!decided.decided_at && decided.submitted_by_name === omar.name && !!decided.submitted_at, "approval submit/decision actors and times available");

  console.log("Chief manages employee API keys");
  const kc = await U.createKey(chief, omar.id, "chief-issued");
  ok(kc.startsWith("ctk_"), "chief issues an employee key");
  await throws(() => U.createKey(chief, owner.id, "x"), 403, "chief cannot create an owner key");
  await throws(() => U.createKey(chief, chief.id, "x"), 403, "chief cannot create a key for a chief");
  await U.createKey(owner, owner.id, "owner key");
  const seen = await U.listKeys(undefined, chief);
  ok(seen.length > 0 && seen.every((x) => x.user_name !== owner.name), "chief never sees the owner's keys");
  const ownerKey = (await U.listKeys(owner.id))[0];
  await throws(() => U.revokeKey(chief, ownerKey.id as number), 403, "chief cannot revoke the owner's key");
  const ek = (await U.listKeys(omar.id, chief)).find((x) => x.label === "chief-issued")!;
  await U.revokeKey(chief, ek.id as number);
  await throws(() => getApiActor(new Request("http://x", { headers: { authorization: `Bearer ${kc}` } })), 401, "chief-revoked key stops working");
  await U.setPermissions(owner, chief.id, ((await U.getUser(chief.id))!.perms as string[]).filter((p) => p !== "keys.manage"));
  const chief2 = await actorById(chief.id);
  await throws(() => U.createKey(chief2, omar.id, "x"), 403, "owner can switch off Chief's key rights");

  console.log("ConexTek categories");
  const cl = await L.createLead(owner, { company: "Auto Dealer NC", market: "china", segment: "nc_dealers", industry: "automotive", service: "after_hours_bdc", source: "cars_com" });
  ok((await L.getLead(owner, cl)).lead.segment === "nc_dealers", "segment saved separately from market");
  await throws(() => L.createLead(owner, { company: "Bad Seg", segment: "nope" }), 400, "unknown segment rejected");
  await throws(() => L.createLead(owner, { company: "Old Market", market: "uk" }), 400, "old generic market no longer offered");
  ok(((await L.listLeads(owner, { segment: "nc_dealers" })).total) === 1, "filter by segment");

  console.log("Original dates, unknown dates, historical import");
  const H = await import("../src/lib/service/history");
  const { addDays, todayYmd, all: dbAll } = await import("../src/lib/db");
  const today0 = todayYmd();
  const past = addDays(today0, -40);
  const base0 = (await R.getRangeReport(owner, { all: true })).totals;
  // A lead found 40 days ago, entered today: counted in its own month, not today.
  const old = await L.createLead(owner, { company: "Old Found Ltd", lead_date: past });
  const oldRow = (await L.getLead(owner, old)).lead;
  ok(oldRow.lead_date_precision === "day" && oldRow.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10), "lead keeps its original date; entry date is separate");
  const todayRep = (await R.getRangeReport(owner, { from: today0, to: today0 })).totals;
  const pastRep = (await R.getRangeReport(owner, { from: past, to: past })).totals;
  ok(pastRep.leads_added === 1, "lead is counted on its original date");
  ok(todayRep.leads_added === (await R.getReport(owner, { granularity: "day" })).totals.leads_added, "range report and daily report agree for today");
  await throws(() => L.createLead(owner, { company: "Future Ltd", lead_date: addDays(today0, 3) }), 400, "future lead date rejected");
  await throws(() => L.createLead(owner, { company: "Bad Date Ltd", lead_date: "14/03/2025" }), 400, "ambiguous date format rejected");

  // CSV-style import without a date: unknown, never "today".
  const unk = await L.createLead(owner, { company: "Unknown Date Ltd" }, false, { unknownDateByDefault: true });
  const unkRow = (await L.getLead(owner, unk)).lead;
  ok(unkRow.lead_date === null, "import without a date leaves the lead date unknown");
  const beforeAll = (await R.getRangeReport(owner, { all: true }));
  ok(beforeAll.totals.leads_added === base0.leads_added + 2 && beforeAll.unknown!.leads_added >= 1, "all-data view includes dated and unknown leads");
  ok((await R.getRangeReport(owner, { from: past, to: today0 })).totals.leads_added === (await R.getRangeReport(owner, { from: past, to: today0 })).buckets.reduce((n, b) => n + b.m.leads_added, 0), "custom period counts only dated leads");

  // Activities: day-only, unknown, bounce date.
  const tline = await L.createLead(owner, { company: "Timeline Co", lead_date: past });
  const sent = await A.recordActivity(owner, tline, { type: "message", message_kind: "first_email", channel: "email", title: "Hi", body: "x", occurred_at: past });
  const sentRow = await one("SELECT * FROM activities WHERE id=?", [sent.id]);
  ok(sentRow!.occurred_precision === "day", "date without hour is kept as a day");
  const bounce = await A.recordActivity(owner, tline, { type: "outcome", outcome: "bounced", parent_id: sent.id, occurred_at: addDays(past, 1) });
  const dPast = (await R.getRangeReport(owner, { from: past, to: past })).totals;
  const dNext = (await R.getRangeReport(owner, { from: addDays(past, 1), to: addDays(past, 1) })).totals;
  ok(dPast.first_emails === 1 && dPast.first_email_bounces === 0, "send counted on the day it was sent");
  ok(dNext.first_email_bounces === 1 && dNext.first_emails === 0, "bounce counted on the day it happened");
  const repsBefore = (await R.getRangeReport(owner, { from: today0, to: today0 })).totals.replies;
  const allBefore = (await R.getRangeReport(owner, { all: true })).totals.replies;
  const ua = await A.recordActivity(owner, tline, { type: "reply", body: "hello", occurred_at: "unknown" });
  const uaRow = await one("SELECT * FROM activities WHERE id=?", [ua.id]);
  ok(uaRow!.occurred_precision === "unknown", "unknown activity date stays unknown");
  const repToday = (await R.getRangeReport(owner, { from: today0, to: today0 })).totals;
  const repAll = (await R.getRangeReport(owner, { all: true })).totals;
  ok(repToday.replies === repsBefore && repAll.replies === allBefore + 1, "unknown-date reply is not counted in a period, only in all data");
  await throws(() => A.recordActivity(owner, tline, { type: "note", body: "x", occurred_at: addDays(today0, 2) }), 400, "future activity date rejected");

  // Bulk correction of existing leads.
  const dry = await H.correctLeadDates(owner, { records: [{ id: unk, lead_date: "2025-03-14" }, { website: "nobody.example", lead_date: "2025-03-14" }] });
  ok(dry.dry_run && dry.counts.will_change === 1 && dry.counts.not_found === 1, "correction dry run changes nothing and reports unmatched rows");
  ok((await L.getLead(owner, unk)).lead.lead_date === null, "dry run left the lead untouched");
  const leadsBefore = Number((await one("SELECT COUNT(*) AS n FROM leads"))!.n);
  const fixed = await H.correctLeadDates(owner, { commit: true, label: "test fix", records: [{ id: unk, lead_date: "2025-03-14", employee: "sara" }] });
  const fx = (await L.getLead(owner, unk)).lead;
  ok(fixed.committed && fx.lead_date_precision === "day" && fx.created_by === sara.id, "correction applied with original employee");
  ok(fx.created_at === unkRow.created_at && Number((await one("SELECT COUNT(*) AS n FROM leads"))!.n) === leadsBefore, "entry date unchanged and nothing created or deleted");
  const au = await one("SELECT * FROM audit_log WHERE action='correct_lead_date' AND entity_id=?", [String(unk)]);
  ok(!!au && String(au.detail).includes("unknown") && String(au.detail).includes("2025-03-14"), "correction is audited with old and new date");
  await throws(() => H.correctLeadDates(sara, { records: [{ id: unk, lead_date: "2025-01-01" }] }), 403, "employee cannot correct dates");
  await throws(() => H.correctLeadDates(chief, { records: [{ id: unk, lead_date: "2025-01-01" }] }), 403, "chief cannot correct dates unless granted");

  // Historical import.
  const payload = () => ({
    label: "test history", employee: "sara",
    leads: [{ external_id: "h-1", company: "History Motors", website: "history.example", market: "china", lead_date: "2025-04-15",
              contacts: [{ name: "Jo", email: "jo@history.example" }, { email: "stop@history.example", do_not_contact: true }] }],
    messages: [{ external_id: "h-1-m1", lead: { external_id: "h-1" }, channel: "email", kind: "first_email", sent_at: "2025-04-16T09:30", contact_email: "jo@history.example", subject: "Hello", body: "text" }],
    replies: [{ external_id: "h-1-r1", lead: { external_id: "h-1" }, in_reply_to: "h-1-m1", channel: "email", received_at: "2025-04-18", body: "Send pricing" }],
    bounces: [{ external_id: "h-1-b1", message_external_id: "h-1-m1", bounced_at: "2025-04-17" }],
  });
  await throws(() => H.importHistory(sara, payload()), 403, "employee cannot import history");
  const hd = await H.importHistory(owner, payload());
  ok(hd.dry_run && !hd.committed && hd.counts.leads.created === 1 && hd.counts.messages.created === 1, "history dry run validates the whole chain");
  ok(!(await one("SELECT id FROM leads WHERE external_id='h-1'")), "history dry run saves nothing");
  const hc = await H.importHistory(owner, { ...payload(), commit: true });
  ok(hc.committed && hc.counts.leads.created === 1 && hc.counts.replies.created === 1 && hc.counts.bounces.created === 1, "history import saved");
  const hl = (await one("SELECT * FROM leads WHERE external_id='h-1'"))!;
  const hm = (await one("SELECT * FROM activities WHERE external_id='h-1-m1'"))!;
  ok(hl.created_by === sara.id && hl.imported_by === owner.id && hl.lead_date_precision === "day", "original employee kept apart from importer (lead)");
  ok(hm.actor_id === sara.id && hm.imported_by === owner.id && hm.occurred_at.startsWith("2025-04-16") && hm.created_at > "2026", "original employee/date kept apart from importer/entry date (message)");
  const dnc = await one("SELECT email_status FROM contacts WHERE lead_id=? AND email='stop@history.example'", [hl.id]);
  ok(dnc!.email_status === "opted_out", "do-not-contact state saved");
  const bc = await one("SELECT email_status FROM contacts WHERE lead_id=? AND email='jo@history.example'", [hl.id]);
  ok(bc!.email_status === "bounced", "bounce marks the contact bounced");
  const again = await H.importHistory(owner, { ...payload(), commit: true });
  ok(again.counts.leads.exists === 1 && again.counts.messages.exists === 1 && again.counts.replies.exists === 1 && again.counts.bounces.exists === 1 && again.batch_id === null, "re-sending the same history creates nothing");
  ok(Number((await one("SELECT COUNT(*) AS n FROM leads WHERE company='History Motors'"))!.n) === 1, "no duplicate lead");
  // Same lead arriving under a new external id: duplicate by website, suppression still carried over.
  const dupLead = await H.importHistory(owner, { label: "dup", employee: "sara", commit: true, leads: [{ external_id: "h-2", company: "History Motors Inc", website: "https://www.history.example", contacts: [{ email: "jo@history.example" }, { email: "new-optout@history.example", email_status: "opted_out" }] }] });
  ok(dupLead.counts.leads.duplicate === 1 && Number((await one("SELECT COUNT(*) AS n FROM leads WHERE domain='history.example'"))!.n) === 1, "duplicate lead skipped");
  ok(!!(await one("SELECT id FROM contacts WHERE lead_id=? AND email='new-optout@history.example' AND email_status='opted_out'", [hl.id])), "do-not-contact carried over to the existing lead");
  // Reports use the original dates.
  ok((await R.getRangeReport(owner, { from: "2025-04-15", to: "2025-04-15" })).totals.leads_added === 1, "imported lead counted on its original date");
  const r16 = (await R.getRangeReport(owner, { from: "2025-04-16", to: "2025-04-16" })).totals;
  const r17 = (await R.getRangeReport(owner, { from: "2025-04-17", to: "2025-04-17" })).totals;
  const r18 = (await R.getRangeReport(owner, { from: "2025-04-18", to: "2025-04-18" })).totals;
  ok(r16.first_emails === 1 && r17.first_email_bounces === 1 && r18.replies === 1, "imported send, bounce and reply counted on the days they happened");
  ok((await R.getReport(owner, { granularity: "day" })).totals.first_emails === (await R.getRangeReport(owner, { from: today0, to: today0 })).totals.first_emails, "importing does not add to today's numbers");
  // Errors block the commit.
  const bad = payload();
  bad.leads[0].external_id = "h-9"; bad.leads[0].company = "Bad Employee Co"; bad.leads[0].website = "bad.example"; bad.leads[0].contacts = [];
  const badRes = await H.importHistory(owner, { ...bad, messages: [{ external_id: "h-9-m", lead: { external_id: "h-9" }, channel: "carrier_pigeon", kind: "first_email", sent_at: "2025-04-16", subject: "x" }], replies: [], bounces: [], commit: true });
  ok(!badRes.committed && badRes.counts.messages.errors === 1 && !(await one("SELECT id FROM leads WHERE external_id='h-9'")), "an error blocks the whole commit");
  const unkMsg = await H.importHistory(owner, { label: "unk", employee: "sara", commit: true, messages: [{ lead: { external_id: "h-1" }, channel: "email", kind: "follow_up", subject: "no date" }] });
  ok(unkMsg.counts.messages.errors === 1, "unknown send date requires an external_id");
  const unkMsg2 = await H.importHistory(owner, { label: "unk", employee: "sara", commit: true, messages: [{ external_id: "h-1-m2", lead: { external_id: "h-1" }, channel: "email", kind: "follow_up", subject: "no date" }] });
  const um = (await one("SELECT * FROM activities WHERE external_id='h-1-m2'"))!;
  ok(unkMsg2.committed && um.occurred_precision === "unknown", "unknown-date history stays unknown");
  void dbAll;

  console.log("Migration access, unknown employee, suppression, reconcile, report API");
  // --- narrowly scoped, revocable, time-limited access for Chief ---
  const permsBefore = [...(await actorById(chief.id)).perms].filter((p) => p !== "history.import").sort().join(",");
  await throws(() => U.setMigrationAccess(chief, omar.id, 24), 403, "chief cannot grant migration access");
  const until = await U.setMigrationAccess(owner, chief.id, 24);
  const chiefM = await actorById(chief.id, "api");
  ok(!!until && chiefM.perms.has("history.import"), "owner grants chief time-limited migration access");
  ok([...chiefM.perms].filter((p) => p !== "history.import").sort().join(",") === permsBefore, "migration access adds no other permission");
  const chiefDry = await H.importHistory(chiefM, { label: "chief dry", employee: null, leads: [{ external_id: "c-1", company: "Chief Test Co" }] });
  ok(chiefDry.dry_run && chiefDry.counts.leads.created === 1, "chief can dry-run with own identity");
  await throws(() => U.setMigrationAccess(chiefM, omar.id, 24), 403, "chief still cannot grant it to others");
  await U.setPermissions(chiefM, omar.id, [...((await U.getUser(omar.id))!.perms as string[]), "history.import"]);
  ok(!(await actorById(omar.id)).perms.has("history.import"), "chief cannot hand history.import to an employee");
  await throws(() => U.createKey(chiefM, owner.id, "x"), 403, "migration access gives no access to owner keys");
  await throws(() => U.createUser(chiefM, { username: "c2x", name: "c2", role: "chief" }), 403, "migration access gives no owner functions");
  ok(!(await actorById(chief.id)).perms.has("message.record_sent") || permsBefore.includes("message.record_sent"), "migration access does not add send-recording rights");
  await U.setMigrationAccess(owner, chief.id, null);
  const chiefRev = await actorById(chief.id, "api");
  await throws(() => H.importHistory(chiefRev, { label: "x", employee: null, leads: [{ company: "Z" }] }), 403, "revoked migration access stops working");
  await U.setMigrationAccess(owner, chief.id, 1);
  const { run: dbRun } = await import("../src/lib/db");
  await dbRun("UPDATE users SET history_import_until=? WHERE id=?", [new Date(Date.now() - 1000).toISOString(), chief.id]);
  const chiefExp = await actorById(chief.id, "api");
  await throws(() => H.importHistory(chiefExp, { label: "x", employee: null, leads: [{ company: "Z" }] }), 403, "expired migration access stops working");
  await U.setMigrationAccess(owner, chief.id, null);

  // --- unknown original employee ---
  const sBefore = (await R.getRangeReport(owner, { all: true })).byEmployee.find((e) => e.user.id === sara.id)?.m;
  const ue = await H.importHistory(owner, { label: "unknown actor", commit: true, employee: null,
    leads: [{ external_id: "u-1", company: "Nobody Knows Motors", website: "nobody.example", lead_date: "2025-07-01" }],
    messages: [{ external_id: "u-1-m1", lead: { external_id: "u-1" }, channel: "email", kind: "first_email", sent_at: "2025-07-02", contact_email: "a@nobody.example", subject: "Hi" },
               { external_id: "u-1-m2", lead: { external_id: "u-1" }, channel: "email", kind: "follow_up", sent_at: "2025-07-09", contact_email: "a@nobody.example", subject: "Following up" },
               { external_id: "u-1-m3", lead: { external_id: "u-1" }, channel: "linkedin", kind: "other", sent_at: "2025-07-10", subject: "LinkedIn hello" }],
    bounces: [{ external_id: "u-1-b2", message_external_id: "u-1-m2", bounced_at: "2025-07-10" }] });
  ok(ue.committed, "unknown original employee accepted (top-level null)");
  const uLead = (await one("SELECT * FROM leads WHERE external_id='u-1'"))!;
  const uMsg = (await one("SELECT * FROM activities WHERE external_id='u-1-m1'"))!;
  ok(uLead.created_by === null && uLead.imported_by === owner.id && uMsg.actor_id === null && uMsg.imported_by === owner.id, "unknown employee stored as NULL, never the importer; imported_by filled");
  const repUnk = await R.getRangeReport(owner, { all: true });
  const unkRow2 = repUnk.byEmployee.find((e) => e.user.id === 0);
  ok(!!unkRow2 && unkRow2.m.first_emails === 1 && unkRow2.m.follow_ups === 1 && unkRow2.m.leads_added === 1, "unknown-actor records listed under 'Unknown original employee'");
  ok(JSON.stringify(repUnk.byEmployee.find((e) => e.user.id === sara.id)?.m) === JSON.stringify(sBefore), "no named employee is credited for unknown-actor work");
  ok(repUnk.totals.first_emails >= (unkRow2?.m.first_emails ?? 0) + 1, "unknown-actor records are in overall totals");
  const perRec = await H.importHistory(owner, { label: "per record", commit: true, employee: "sara",
    messages: [{ external_id: "u-1-m4", lead: { external_id: "u-1" }, channel: "email", kind: "other", sent_at: "2025-07-11", subject: "Other", employee: null }] });
  ok(perRec.committed && (await one("SELECT actor_id FROM activities WHERE external_id='u-1-m4'"))!.actor_id === null, "per-record employee:null overrides the top-level employee");
  const noEmp = await H.importHistory(owner, { label: "no emp", messages: [{ external_id: "u-1-m5", lead: { external_id: "u-1" }, channel: "email", kind: "other", sent_at: "2025-07-12", subject: "x" }] });
  ok(noEmp.counts.messages.errors === 1 && String(noEmp.results.messages[0].message).includes("null"), "missing employee is an error that explains null");
  const dncNoEmp = await H.importHistory(owner, { label: "dnc", employee: null, commit: true, do_not_contact: [{ lead: { external_id: "u-1" }, email: "b@nobody.example", at: "2025-07-15" }] });
  ok(dncNoEmp.committed && (await one("SELECT email_status FROM contacts WHERE email='b@nobody.example'"))!.email_status === "opted_out", "do_not_contact follows the same employee rule (null allowed)");

  // --- follow-up bounce linked to the follow-up, not the first email ---
  const m2 = (await one("SELECT * FROM activities WHERE external_id='u-1-m2'"))!;
  const b2 = (await one("SELECT * FROM activities WHERE external_id='u-1-b2'"))!;
  ok(b2.parent_id === m2.id && b2.message_kind === "follow_up", "bounce is linked to the follow-up and takes its kind");
  const d10 = (await R.getRangeReport(owner, { from: "2025-07-10", to: "2025-07-10" })).totals;
  ok(d10.follow_up_bounces === 1 && d10.first_email_bounces === 0, "follow-up bounce is not counted against first emails");
  const coh = (await R.getRangeReport(owner, { from: "2025-07-09", to: "2025-07-09" })).totals;
  ok(coh.follow_ups === 1 && coh.follow_up_cohort_bounces === 1 && coh.follow_up_bounces === 0, "late bounce: event view in bounce period, cohort view in send period");
  const wrongKind = await H.importHistory(owner, { label: "wk", employee: null, bounces: [{ external_id: "u-1-bx", message_external_id: "u-1-m2", kind: "first_email", bounced_at: "2025-07-11" }] });
  ok(wrongKind.counts.bounces.errors === 1, "bounce naming the wrong kind is rejected");
  const bounceOfReply = await H.importHistory(owner, { label: "br", employee: null, bounces: [{ external_id: "u-1-by", message_external_id: "h-1-r1", bounced_at: "2025-07-11" }] });
  ok(bounceOfReply.counts.bounces.errors === 1, "bounce cannot attach to a reply");
  const noRef = await H.importHistory(owner, { label: "nr", employee: null, bounces: [{ external_id: "u-1-bz", bounced_at: "2025-07-11" }] });
  ok(noRef.counts.bounces.errors === 1, "bounce without an exact message reference is an error (never guessed)");
  const lateUnknown = await H.importHistory(owner, { label: "lu", employee: null, commit: true,
    messages: [{ external_id: "u-1-m6", lead: { external_id: "u-1" }, channel: "email", kind: "follow_up", subject: "undated follow-up" }],
    bounces: [{ external_id: "u-1-b6", message_external_id: "u-1-m6", bounced_at: "2025-07-20" }] });
  ok(lateUnknown.committed, "dated bounce on an unknown-date message passes chronology (nothing to compare)");
  const crossBatch = await H.importHistory(owner, { label: "xb", employee: null, commit: true, replies: [{ external_id: "u-1-r1", in_reply_to: "u-1-m1", channel: "email", received_at: "2025-07-03", body: "ok" }] });
  ok(crossBatch.committed && (await one("SELECT parent_id FROM activities WHERE external_id='u-1-r1'"))!.parent_id === uMsg.id, "reply references a message imported in another batch");
  const early = await H.importHistory(owner, { label: "er", employee: null, replies: [{ external_id: "u-1-r2", in_reply_to: "u-1-m1", channel: "email", received_at: "2025-06-01", body: "too early" }] });
  ok(early.counts.replies.errors === 1, "reply earlier than its message is rejected");

  // --- suppressed, historical-only entities ---
  const hist = await H.importHistory(owner, { label: "suppressed", employee: null, commit: true,
    leads: [{ external_id: "s-1", company: "Opted Out Corp", website: "optedout.example", historical_only: true,
              contacts: [{ email: "one@optedout.example", email_status: "opted_out" }, { email: "two@optedout.example", email_status: "bounced" }] }],
    replies: [{ external_id: "s-1-r", lead: { external_id: "s-1" }, channel: "email", received_at: "2025-08-05", body: "Please remove us", contact_email: "one@optedout.example" }] });
  ok(hist.committed, "historical-only suppressed entity imported with its reply");
  const sLead = (await one("SELECT * FROM leads WHERE external_id='s-1'"))!;
  ok(sLead.historical_only === 1, "entity flagged historical-only");
  ok((await L.listLeads(owner, {})).rows.some((r) => r.id === sLead.id) && !(await L.listLeads(owner, { includeHistorical: false })).rows.some((r) => r.id === sLead.id) && (await L.listLeads(owner, { q: sLead.company ?? "" })).rows.some((r) => r.id === sLead.id), "historical-only entity is listed and searchable by default, hideable on request");
  await throws(() => T.createTask(owner, { lead_id: sLead.id, assignee_id: sara.id, title: "chase them" }), 400, "no task can be assigned on a historical-only entity");
  ok((await R.getRangeReport(owner, { from: "2025-08-05", to: "2025-08-05" })).totals.replies === 1 && (await R.getRangeReport(owner, { from: "2025-08-01", to: "2025-08-31" })).totals.leads_added === 0, "its reply counts on its date; it is not a lead added");
  const reimport = await H.importHistory(owner, { label: "reimport", employee: null, commit: true,
    leads: [{ external_id: "s-1b", company: "Opted Out Corp", contacts: [{ email: "one@optedout.example", email_status: "ok" }, { email: "two@optedout.example", email_status: "unknown" }] },
            { external_id: "s-1c", company: "Opted Out Corp Again", website: "https://www.optedout.example/", contacts: [{ email: "one@optedout.example" }] }] });
  ok(reimport.counts.leads.duplicate === 2, "duplicate matches of the suppressed entity are skipped");
  const st = await dbAll("SELECT email,email_status FROM contacts WHERE lead_id=? ORDER BY email", [sLead.id]);
  ok(st.length === 2 && st[0].email_status === "opted_out" && st[1].email_status === "bounced", "suppression survives duplicate matches (multiple addresses, per contact)");
  const oc = (await one("SELECT id FROM contacts WHERE lead_id=? AND email='one@optedout.example'", [sLead.id]))!;
  const { updateContact } = L;
  const asOwnerOfLead = await actorById(sara.id, "api");
  await throws(() => updateContact(asOwnerOfLead, oc.id as number, { email_status: "ok" }), 403, "an employee cannot clear a suppression");
  await updateContact(owner, oc.id as number, { email_status: "ok" });
  ok((await one("SELECT email_status FROM contacts WHERE id=?", [oc.id]))!.email_status === "ok", "Owner can make an explicit, audited correction");
  await updateContact(owner, oc.id as number, { email_status: "opted_out" });
  ok(!(await one("SELECT id FROM tasks WHERE lead_id=?", [sLead.id])), "historical import created no tasks or outreach");

  // --- reconcile existing activities (regular API) with import ids, no duplicates ---
  const rl = await L.createLead(owner, { company: "Steelmate Test", website: "steelmate.example", lead_date: "2025-09-01" });
  const rec = await A.recordActivity(owner, rl, { type: "reply", channel: "email", body: "Interested, send details", occurred_at: addDays(today0, -3) + "T09:50", task_id: undefined });
  const near = await H.importHistory(owner, { label: "near", employee: "sara", replies: [{ external_id: "steel-r1", lead: { id: rl }, channel: "email", received_at: addDays(today0, -3), body: "Interested, send details" }] });
  ok(near.counts.replies.errors === 1 && String(near.results.replies[0].message).includes(`#${rec.id}`) && String(near.results.replies[0].message).includes("reconcile"), "a day-only import near an API-entered reply is flagged, not duplicated");
  const actCount = Number((await one("SELECT COUNT(*) AS n FROM activities"))!.n);
  const rcDry = await H.reconcileActivities(owner, { records: [{ activity_id: rec.id, external_id: "steel-r1", lead_id: rl, type: "reply" }] });
  ok(rcDry.dry_run && rcDry.counts.will_change === 1 && !(await one("SELECT external_id FROM activities WHERE id=?", [rec.id]))!.external_id, "reconcile dry run changes nothing");
  const badLead = await H.reconcileActivities(owner, { records: [{ activity_id: rec.id, external_id: "x", lead_id: 999999 }], commit: true });
  ok(badLead.counts.errors === 1 && !badLead.committed, "reconcile checks the lead id and changes nothing on error");
  const rc = await H.reconcileActivities(owner, { commit: true, label: "attach", records: [{ activity_id: rec.id, external_id: "steel-r1", lead_id: rl, type: "reply", employee: "omar" }] });
  const rcRow = (await one("SELECT * FROM activities WHERE id=?", [rec.id]))!;
  ok(rc.committed && rcRow.external_id === "steel-r1" && rcRow.actor_id === omar.id && rcRow.imported_by === owner.id, "reconcile attaches external_id, corrects original employee and keeps the recorder");
  ok(rcRow.occurred_at === (await one("SELECT occurred_at FROM activities WHERE id=?", [rec.id]))!.occurred_at && Number((await one("SELECT COUNT(*) AS n FROM activities"))!.n) === actCount, "reconcile creates and deletes nothing");
  const again2 = await H.importHistory(owner, { label: "near2", employee: "sara", commit: true, replies: [{ external_id: "steel-r1", lead: { id: rl }, channel: "email", received_at: addDays(today0, -3), body: "Interested, send details" }] });
  ok(again2.counts.replies.exists === 1 && Number((await one("SELECT COUNT(*) AS n FROM activities WHERE lead_id=? AND type='reply'", [rl]))!.n) === 1, "after reconcile the same reply is recognised, no duplicate");
  ok(!!(await one("SELECT id FROM audit_log WHERE action='reconcile_activity' AND entity_id=?", [String(rec.id)])), "reconcile is audited");
  const distinct = await H.importHistory(owner, { label: "distinct", employee: "sara", commit: true, replies: [{ external_id: "steel-r2", lead: { id: rl }, channel: "email", received_at: addDays(today0, -3), body: "A second, different reply", not_activity_ids: [rec.id] }] });
  ok(distinct.committed && distinct.counts.replies.created === 1, "not_activity_ids states explicitly that a record is a different event");
  const fixEmp = await H.correctLeadDates(owner, { commit: true, records: [{ id: rl, employee: null }] });
  const rlRow = (await L.getLead(owner, rl)).lead;
  ok(fixEmp.committed && rlRow.created_by === null && rlRow.lead_date_precision === "day" && rlRow.imported_by === owner.id, "original employee can be corrected to unknown without touching the date; recorder kept");
  const keepUnknown = await H.correctLeadDates(owner, { records: [{ id: unk, lead_date: "unknown" }, { id: old, lead_date: null }] });
  ok(keepUnknown.counts.errors === 0 && (keepUnknown.results[0].status === "unchanged" || keepUnknown.results[0].status === "will_change"), "'unknown'/null are accepted as explicit unknown dates");

  // --- report API ---
  const api = await R.reportApi(owner, { all: true });
  ok(api.view === "all" && api.timezone && api.rules.bounces.includes("cohort") && api.unknown_counts.leads >= 0 && !!api.unknown, "report API returns all-data view with rules and unknown counts");
  const apiUnk = await R.reportApi(owner, { from: "2025-07-01", to: "2025-07-31", employee: "unknown" });
  ok(apiUnk.totals.first_emails === 1 && apiUnk.totals.follow_ups === 1 && apiUnk.rates.follow_up_cohort_bounce_rate === 1, "report API filters by unknown employee and exposes cohort rates");
  const apiSara = await R.reportApi(owner, { from: "2025-07-01", to: "2025-07-31", employee: "sara" });
  ok(apiSara.totals.first_emails === 0, "named employee filter excludes unknown-actor work");
  const apiPeriod = await R.reportApi(owner, { period: "month", at: "2025-07-15" });
  ok(apiPeriod.view === "period" && apiPeriod.totals.reply_leads === 1, "report API period view; reply_leads counts distinct leads");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
