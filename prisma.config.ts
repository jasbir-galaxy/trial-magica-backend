import { loadEnvConfig } from "@next/env";
import { defineConfig } from "prisma/config";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation is also used during installation, before runtime secrets exist.
  // Migrations use a direct connection; application reads retain the pooled URL.
  // DATABASE_URL_UNPOOLED is supplied by the Neon/Vercel integration.
  datasource: { url: process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL },
});
