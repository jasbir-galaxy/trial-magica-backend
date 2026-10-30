import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { deploymentIssues } from "../src/config/deployment";

// Never load .env.local implicitly: it contains development credentials.
try {
  const env = process.argv[2] ? parseEnv(readFileSync(process.argv[2], "utf8")) : process.env;
  const issues = deploymentIssues(env);
  if (issues.length) {
    console.error(`Production configuration is incomplete or invalid: ${issues.join(", ")}.`);
    process.exitCode = 1;
  } else {
    console.log("Production configuration passed. Credentials and live connectivity still require deployment smoke checks.");
  }
} catch {
  console.error("Could not read production configuration. Supply a readable, ignored environment file; never paste secrets into chat.");
  process.exitCode = 1;
}
