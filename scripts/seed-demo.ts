// npm run seed:demo            -> load clearly-labelled demo data (excluded from reports)
// npm run seed:demo -- --remove -> delete all demo data
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
  const { actorById } = await import("../src/lib/auth");
  const { one, ready } = await import("../src/lib/db");
  const { seedDemo, removeDemo } = await import("../src/lib/service/demo");
  await ready();
  const o = await one("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  if (!o) throw new Error("No owner account yet — set OWNER_USERNAME/OWNER_PASSWORD and start the app once.");
  const owner = await actorById(o.id);
  if (process.argv.includes("--remove")) { await removeDemo(owner); console.log("Demo data removed."); }
  else { await seedDemo(owner); console.log("Demo data loaded (flagged is_demo, hidden by default, excluded from reports)."); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
