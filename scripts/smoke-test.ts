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
  await throws(() => U.createKey(chief, e2.id, "x"), 403, "chief cannot create API keys");
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
