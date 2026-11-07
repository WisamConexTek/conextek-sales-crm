import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { ready } from "../src/lib/db";
ready().then(() => { console.log("Database is up to date."); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
