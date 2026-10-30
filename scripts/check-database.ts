import { loadEnvConfig } from "@next/env";
import { getDatabase } from "../src/db/client";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  const database = getDatabase();
  try {
    const rows = await database.$queryRaw<Array<{ database: string; user: string }>>`
      SELECT current_database() AS database, current_user AS "user"
    `;
    if (rows.length !== 1) throw new Error("Expected one database identity row.");
    console.info("Database connection verified:", rows[0]);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Do not print connection strings or server error details containing secrets.
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  console.error("Database check failed. Check DATABASE_URL and database availability.",
    typeof code === "string" ? `Code: ${code}` : "");
  process.exitCode = 1;
});
