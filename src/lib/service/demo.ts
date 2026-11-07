import { all, one, run, tx, now } from "../db";
import { HttpError, actorById, type Actor } from "../auth";
import { PRESETS } from "../constants";
import { audit } from "./common";
import { createLead, setStage } from "./leads";
import { recordActivity } from "./activities";
import { createTask, submitTask, decideApproval } from "./tasks";

const DEMO_USERS = [
  { username: "demo.researcher", name: "Demo Researcher", preset: "researcher" },
  { username: "demo.outreach", name: "Demo Outreach", preset: "outreach" },
];

/** Demo rows carry is_demo=1: hidden by default and NEVER counted in dashboard/reports. Demo users are disabled (cannot sign in). */
export async function seedDemo(owner: Actor) {
  if (owner.role !== "owner") throw new HttpError(403, "Only the owner can load demo data.");
  if (await one("SELECT id FROM leads WHERE is_demo=1 LIMIT 1")) throw new HttpError(400, "Demo data is already loaded.");
  const ids: number[] = [];
  for (const u of DEMO_USERS) {
    const ex = await one("SELECT id FROM users WHERE username=?", [u.username]);
    if (ex) { ids.push(ex.id); continue; }
    const t = now();
    const r = await run(
      `INSERT INTO users (username,name,role,preset,permissions,password_hash,active,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)`,
      [u.username, u.name, "employee", u.preset, JSON.stringify(PRESETS[u.preset].perms), "!disabled-demo-account", t, t],
    );
    ids.push(r.id);
  }
  const res = await actorById(ids[0]), out = await actorById(ids[1]);
  const day = 86400000, ago = (d: number) => new Date(Date.now() - d * day).toISOString();

  const mk = (company: string, country: string, market: string, owner_id: number, extra: Record<string, unknown> = {}) =>
    createLead(owner, { company: `[DEMO] ${company}`, website: `https://demo-${company.toLowerCase().replace(/\W+/g, "")}.example`, country, market, industry: "technology", language: "en", source: "manual_research", owner_id, ...extra }, true);

  const a = await mk("Northwind Traders", "UAE", "uae", out.id, { contacts: [{ name: "Layla Hassan", role: "Head of Sales", email: "layla@demo-northwind.example" }], next_action: "Send follow-up", next_due_at: new Date(Date.now() + 2 * day).toISOString() });
  const b = await mk("Contoso Retail", "Saudi Arabia", "ksa", out.id, { contacts: [{ name: "Omar Aziz", role: "COO", email: "omar@demo-contoso.example" }] });
  const c = await mk("Fabrikam Labs", "United Kingdom", "uk", res.id, { next_action: "Finish company research", next_due_at: new Date(Date.now() - day).toISOString() });
  await mk("Tailspin Toys", "United States", "us", res.id);

  const ca = (await one("SELECT id FROM contacts WHERE lead_id=?", [a]))!.id, cb = (await one("SELECT id FROM contacts WHERE lead_id=?", [b]))!.id;
  await recordActivity(res, c, { type: "research", title: "Company profile", body: "Mid-size lab; no CRM visible on site.", occurred_at: ago(3) });
  await setStage(out, a, "researching", "Started research (demo)");
  const m1 = await recordActivity(out, a, { type: "message", message_kind: "first_email", channel: "email", contact_id: ca, title: "Quick question", body: "Hi Layla, …", ref: "demo-msg-1", occurred_at: ago(5) });
  await setStage(out, a, "contacted", "First email sent (demo)");
  await recordActivity(out, a, { type: "reply", channel: "email", contact_id: ca, body: "Thanks — please send pricing.", occurred_at: ago(2) });
  await setStage(out, a, "replied", "Layla asked for pricing (demo)");
  const m2 = await recordActivity(out, b, { type: "message", message_kind: "first_email", channel: "email", contact_id: cb, title: "Introduction", body: "Hi Omar, …", occurred_at: ago(1) });
  await recordActivity(out, b, { type: "outcome", outcome: "bounced", parent_id: m2.id });
  void m1;

  const chiefLike = owner; // demo tasks are created by the owner
  const t1 = await createTask(chiefLike, { title: "[DEMO] Draft first email for Fabrikam", lead_id: c, assignee_id: res.id, task_type: "first_email_draft", due_at: new Date(Date.now() + day).toISOString(), instructions: "Keep it under 90 words." }, true);
  await submitTask(res, t1, { kind: "draft", content: "Subject: Hello Fabrikam\n\nDemo draft text." });
  const t2 = await createTask(chiefLike, { title: "[DEMO] Pricing offer for Northwind", lead_id: a, assignee_id: out.id, task_type: "pricing_offer" }, true);
  await submitTask(out, t2, { kind: "other", content: "Proposed: starter plan, 12 months." });
  const t3 = await createTask(chiefLike, { title: "[DEMO] Follow up with Contoso", lead_id: b, assignee_id: out.id, task_type: "follow_up_draft", due_at: ago(1) }, true);
  void t3; void decideApproval;
  await audit(owner, "load_demo_data", "system", null);
}

export async function removeDemo(owner: Actor) {
  if (owner.role !== "owner") throw new HttpError(403, "Only the owner can remove demo data.");
  await tx([
    { sql: "DELETE FROM approvals WHERE is_demo=1" },
    { sql: "DELETE FROM activities WHERE is_demo=1" },
    { sql: "DELETE FROM tasks WHERE is_demo=1" },
    { sql: "DELETE FROM contacts WHERE lead_id IN (SELECT id FROM leads WHERE is_demo=1)" },
    { sql: "DELETE FROM leads WHERE is_demo=1" },
  ]);
  for (const u of DEMO_USERS) {
    try { await run("DELETE FROM users WHERE username=? AND active=0", [u.username]); } catch { /* still referenced: leave disabled */ }
  }
  await audit(owner, "remove_demo_data", "system", null);
}

export const demoCount = async () => Number((await one("SELECT COUNT(*) n FROM leads WHERE is_demo=1"))!.n);
void all;
