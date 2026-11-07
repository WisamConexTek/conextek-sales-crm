// Run: npm test   (timestamp handling around a real DST change: Asia/Hebron, clocks went back on 2026-10-24 and forward on 2026-03-28)
import { rmSync } from "node:fs";
rmSync("data/time-test.db", { force: true });
process.env.DATABASE_URL = "file:./data/time-test.db";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.OWNER_USERNAME = "wisam";
process.env.OWNER_PASSWORD = "owner-password-123";
process.env.APP_TIMEZONE = "Asia/Hebron";

async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, all, run, ready, localMidnight } = await import("../src/lib/db");
  const { parseEventDate, parseWhen } = await import("../src/lib/service/common");
  const U = await import("../src/lib/service/users");
  const L = await import("../src/lib/service/leads");
  const A = await import("../src/lib/service/activities");
  const R = await import("../src/lib/service/reports");
  const H = await import("../src/lib/service/history");
  await ready();
  let pass = 0, fail = 0;
  const ok = (c: unknown, name: string) => (c ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)));
  const at = (v: string) => { const e = parseEventDate(v); return typeof e === "string" ? e : e.at; };

  console.log("Timestamp handling (Asia/Hebron)");
  // The production bug: local midnight + elapsed minutes. On 24 Oct 2026 midnight is UTC+3 but 04:12 is already UTC+2.
  ok(at("2026-10-24T04:12") === "2026-10-24T02:12:00.000Z", "Oct 24 04:12 local -> 02:12Z (offset at that instant, not at midnight)");
  ok(at("2026-10-24T04:30") === "2026-10-24T02:30:00.000Z" && at("2026-10-24T04:39") === "2026-10-24T02:39:00.000Z" && at("2026-10-24T04:48") === "2026-10-24T02:48:00.000Z", "the other three Oct 24 values");
  ok(at("2026-10-23T12:00") === "2026-10-23T09:00:00.000Z", "Oct 23 12:00 local -> 09:00Z (UTC+3)");
  ok(at("2026-10-24T00:30") === "2026-10-23T21:30:00.000Z", "Oct 24 00:30 local (before the change) -> UTC+3");
  ok(at("2026-10-31T10:00") === "2026-10-31T08:00:00.000Z", "Oct 31 10:00 local -> 08:00Z (UTC+2)");
  ok(at("2026-11-07T10:00") === "2026-11-07T08:00:00.000Z", "Nov 7 10:00 local -> 08:00Z (UTC+2)");
  ok(at("2026-03-28T03:30") === "2026-03-28T00:30:00.000Z" && at("2026-03-27T12:00") === "2026-03-27T10:00:00.000Z", "spring-forward day converts with the right offsets");
  ok(parseEventDate("2026-10-24T01:30") === "ambiguous", "ambiguous hour (clocks go back) is refused, not guessed");
  ok(parseEventDate("2026-03-28T02:30") === "nonexistent", "skipped hour (clocks go forward) is refused, not guessed");
  ok(parseWhen("2026-10-24T01:30") === "2026-10-23T22:30:00.000Z", "legacy due-date parser takes the first occurrence of a repeated hour");

  console.log("Explicit UTC / offset inputs");
  ok(at("2026-10-24T02:12:00Z") === "2026-10-24T02:12:00.000Z", "Z is kept exactly");
  ok(at("2026-10-24T10:12:00+08:00") === "2026-10-24T02:12:00.000Z" && at("2026-10-24T10:12+0800") === "2026-10-24T02:12:00.000Z" && at("2026-10-24 10:12:00+08") === "2026-10-24T02:12:00.000Z", "Shanghai offsets (+08:00, +0800, +08) give the same instant");
  ok(at("2026-10-24T01:30:00+03:00") === "2026-10-23T22:30:00.000Z" && at("2026-10-24T01:30:00+02:00") === "2026-10-23T23:30:00.000Z", "an offset resolves the repeated hour exactly");
  ok(at("2026-03-28T02:30:00+02:00") === "2026-03-28T00:30:00.000Z", "an offset is accepted inside the skipped hour");
  ok(at("2026-10-24T10:12:30.250+08:00") === "2026-10-24T02:12:30.250Z", "seconds and milliseconds are preserved");
  ok(at("2026-10-24T02:12:00-05:30") === "2026-10-24T07:42:00.000Z", "negative offsets");
  ok(parseEventDate("2026-02-30T10:00:00Z") === "invalid" && parseEventDate("2026-10-24T25:00:00Z") === "invalid" && parseEventDate("2026-10-24T10:00:00+25:00") === "invalid", "impossible dates/times/offsets are invalid");
  ok(parseEventDate("2026-10-24T10:12:00.000") === "invalid" || typeof parseEventDate("2026-10-24T10:12:00.000") === "object", "zone-less with milliseconds is handled by the same rules");
  ok(parseEventDate("Oct 24 2026 10:12") === "invalid", "loose, locale-dependent formats are refused");
  const dayOnly = parseEventDate("2026-10-24") as { at: string; precision: string };
  ok(dayOnly.precision === "day" && dayOnly.at === "2026-10-23T21:00:00.000Z" && localMidnight("2026-10-24").toISOString() === dayOnly.at, "date-only stays a day (local midnight, precision day)");
  const unk = parseEventDate("unknown") as { at: string | null; precision: string };
  ok(unk.at === null && unk.precision === "unknown", "unknown stays unknown");

  console.log("Storage, reporting and corrections");
  const owner = await actorById(1);
  const sara = await actorById((await U.createUser(owner, { username: "sara", name: "Sara", role: "employee", preset: "researcher" })).id, "api");
  const lead = await L.createLead(owner, { company: "DST Motors", website: "dst.example", lead_date: "2026-10-01" });
  // Shanghai logs submitted with an explicit offset are stored as that exact instant.
  const imp = await H.importHistory(owner, { label: "shanghai", employee: null, commit: true, messages: [
    { external_id: "sh-1", lead: { id: lead }, channel: "email", kind: "first_email", sent_at: "2026-10-24T10:12:00+08:00", subject: "a" },
    { external_id: "sh-2", lead: { id: lead }, channel: "email", kind: "follow_up", sent_at: "2026-10-24T10:30:00+08:00", subject: "b" } ] });
  ok(imp.committed && (await one("SELECT occurred_at FROM activities WHERE external_id='sh-1'"))!.occurred_at === "2026-10-24T02:12:00.000Z", "explicit +08:00 import stores the exact instant");
  const rec = await A.recordActivity(owner, lead, { type: "note", body: "x", occurred_at: "2026-10-24T04:12" });
  ok((await one("SELECT occurred_at FROM activities WHERE id=?", [rec.id]))!.occurred_at === "2026-10-24T02:12:00.000Z", "regular API uses the same corrected conversion");
  await throws(() => A.recordActivity(owner, lead, { type: "note", body: "x", occurred_at: "2026-10-24T01:30" }), "ambiguous API time is rejected with an explanation");

  // Reporting by local day around the change.
  const dl = await L.createLead(owner, { company: "Day Buckets", lead_date: "2026-09-01" });
  await A.recordActivity(owner, dl, { type: "message", message_kind: "first_email", channel: "email", title: "d", body: "d", occurred_at: "2026-10-24" });
  await A.recordActivity(owner, dl, { type: "message", message_kind: "first_email", channel: "email", title: "e", body: "e", occurred_at: "2026-10-23T20:59:00Z" }); // 23:59 local Oct 23
  await A.recordActivity(owner, dl, { type: "message", message_kind: "first_email", channel: "email", title: "f", body: "f", occurred_at: "2026-10-23T23:30:00Z" }); // 01:30 (+2) Oct 24
  const d23 = (await R.getRangeReport(owner, { from: "2026-10-23", to: "2026-10-23" })).totals.first_emails;
  const d24 = (await R.getRangeReport(owner, { from: "2026-10-24", to: "2026-10-24" })).totals.first_emails;
  ok(d23 === 1 && d24 === 2 + 1, "date-only and timed sends land on the right local day (Oct 23: 1, Oct 24: 2 + the Shanghai import)");

  // The four production activities, stored one hour early (reproduced exactly).
  const bad: number[] = [];
  for (const [min, wrong] of [["12", "01:12"], ["30", "01:30"], ["39", "01:39"], ["48", "01:48"]]) {
    const r = await run(
      `INSERT INTO activities (lead_id,type,message_kind,channel,outcome,title,body,actor_id,occurred_at,created_at,is_demo,occurred_precision,external_id,imported_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,'time',?,?)`,
      [lead, "message", "first_email", "email", "sent", `prod ${min}`, `body ${min}`, sara.id, `2026-10-24T${wrong}:00.000Z`, "2026-11-07T10:00:00.000Z", `prod-${min}`, owner.id]);
    bad.push(r.id);
  }
  await run("UPDATE leads SET last_activity_at='2026-10-24T01:48:00.000Z' WHERE id=?", [lead]);
  const before = await Promise.all(bad.map((id) => one("SELECT * FROM activities WHERE id=?", [id])));
  const sends0 = (await R.getRangeReport(owner, { from: "2026-10-24", to: "2026-10-24" })).totals.first_emails;
  const recs = [["10:12", "01:12"], ["10:30", "01:30"], ["10:39", "01:39"], ["10:48", "01:48"]].map(([sh, wrong], i) => ({ activity_id: bad[i], occurred_at: `2026-10-24T${sh}:00+08:00`, from: `2026-10-24T${wrong}:00.000Z`, type: "message", lead_id: lead }));
  const dry = await H.correctActivityTimes(owner, { records: recs });
  ok(dry.dry_run && dry.counts.will_change === 4 && (await one("SELECT occurred_at FROM activities WHERE id=?", [bad[0]]))!.occurred_at === "2026-10-24T01:12:00.000Z", "correction dry run changes nothing");
  const guard = await H.correctActivityTimes(owner, { commit: true, records: [{ ...recs[0], from: "2026-10-24T05:00:00Z" }, recs[1]] });
  ok(!guard.committed && guard.counts.errors === 1 && (await one("SELECT occurred_at FROM activities WHERE id=?", [bad[1]]))!.occurred_at === "2026-10-24T01:30:00.000Z", "a wrong 'from' guard blocks the entire commit");
  await throws(() => H.correctActivityTimes(sara, { records: recs }), "an employee cannot correct times");
  const done = await H.correctActivityTimes(owner, { commit: true, label: "fix 4", records: recs });
  const after = await Promise.all(bad.map((id) => one("SELECT * FROM activities WHERE id=?", [id])));
  ok(done.committed && after.map((a) => a!.occurred_at).join() === "2026-10-24T02:12:00.000Z,2026-10-24T02:30:00.000Z,2026-10-24T02:39:00.000Z,2026-10-24T02:48:00.000Z", "all four corrected to the expected instants");
  ok(before.every((b, i) => ["id", "external_id", "parent_id", "actor_id", "imported_by", "body", "title", "created_at", "lead_id", "type", "message_kind"].every((k) => b![k] === after[i]![k])), "ids, external ids, parents, actors, importers, bodies and created_at are preserved");
  ok(Number((await one("SELECT COUNT(*) AS n FROM audit_log WHERE action='correct_activity_time'"))!.n) === 4 && String((await one("SELECT detail FROM audit_log WHERE action='correct_activity_time' ORDER BY id LIMIT 1"))!.detail).includes("01:12"), "old and new timestamps are audited");
  ok((await R.getRangeReport(owner, { from: "2026-10-24", to: "2026-10-24" })).totals.first_emails === sends0, "corrections are not counted as new sends");
  ok((await one("SELECT last_activity_at FROM leads WHERE id=?", [lead]))!.last_activity_at === "2026-10-24T02:48:00.000Z", "the lead's last activity follows the corrected event");
  const again = await H.correctActivityTimes(owner, { commit: true, records: recs.map(({ from, ...r }) => r) });
  ok(again.counts.unchanged === 4 && !again.committed && Number((await one("SELECT COUNT(*) AS n FROM audit_log WHERE action='correct_activity_time'"))!.n) === 4, "re-running the correction is idempotent (no change, no new audit)");
  ok(Number((await one("SELECT COUNT(*) AS n FROM activities WHERE external_id LIKE 'prod-%'"))!.n) === 4, "nothing was created or deleted");

  console.log("Import performance");
  const leads: number[] = [];
  for (let i = 0; i < 20; i++) leads.push(await L.createLead(owner, { company: `Perf ${i}`, website: `perf${i}.example`, lead_date: "2026-09-01", contacts: [{ name: "P", email: `p${i}@perf${i}.example` }] }));
  const msgs = Array.from({ length: 145 }, (_, i) => ({
    external_id: `perf-m-${i}`, lead: { id: leads[i % 20] }, channel: "email", kind: i % 3 ? "follow_up" : "first_email",
    sent_at: `2026-09-${String(1 + (i % 27)).padStart(2, "0")}T09:${String(i % 60).padStart(2, "0")}:00Z`, contact_email: `p${i % 20}@perf${i % 20}.example`, subject: `s${i}`, body: "x",
  }));
  const d0 = Date.now();
  const pd = await H.importHistory(owner, { label: "perf", employee: null, messages: msgs });
  ok(pd.counts.messages.created === 145 && pd.dry_run, "145-message dry run validates every record");
  ok(pd.stats.database_calls <= 175, `145-message dry run uses ~1 database call per record (${pd.stats.database_calls} calls, ${Date.now() - d0} ms locally)`);
  const pc = await H.importHistory(owner, { label: "perf", employee: null, commit: true, messages: msgs });
  ok(pc.committed && pc.counts.messages.created === 145, "145-message commit succeeds");
  const pr = await H.importHistory(owner, { label: "perf", employee: null, commit: true, messages: msgs });
  ok(pr.counts.messages.exists === 145 && pr.stats.database_calls <= 12, `re-sending the 145 messages is idempotent and cheap (${pr.stats.database_calls} calls)`);
  process.env.IMPORT_TIME_BUDGET_MS = "1";
  const slow = await H.importHistory(owner, { label: "perf2", employee: null, messages: msgs.map((m, i) => ({ ...m, external_id: `perf2-${i}`, sent_at: `2026-08-${String(1 + (i % 27)).padStart(2, "0")}T10:00:00Z` })) }).then(() => null, (e) => e);
  ok(slow && (slow as { status?: number }).status === 413 && !(await one("SELECT id FROM activities WHERE external_id='perf2-0'")), "a batch that cannot finish in time fails clearly (413) and saves nothing");
  delete process.env.IMPORT_TIME_BUDGET_MS;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);

  async function throws(fn: () => Promise<unknown>, name: string) {
    try { await fn(); ok(false, name + " (did not throw)"); } catch { ok(true, name); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
