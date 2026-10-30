import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Refuse to run fixture writes or cleanup against an application database.
const connectionString = process.env.DATABASE_TEST_URL;
if (!connectionString) throw new Error("Set DATABASE_TEST_URL to the local magica_trial_test database.");
const url = new URL(connectionString);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "5433" || url.pathname !== "/magica_trial_test") {
  throw new Error("Integration tests require the local magica_trial_test database on port 5433.");
}
process.env.DATABASE_URL = connectionString;
export default defineConfig({
  test: { include: ["tests/**/*.integration.test.ts"], fileParallelism: false },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
