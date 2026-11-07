import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["@libsql/client", "bcryptjs"],
};
export default config;
