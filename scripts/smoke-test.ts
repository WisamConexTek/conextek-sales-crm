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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
