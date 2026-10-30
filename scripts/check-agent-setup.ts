import { loadEnvConfig } from "@next/env";
import { AgentConfigurationError, FREE_MODEL, readAgentEnvironment } from "../src/config/agent";

loadEnvConfig(process.cwd(), true);
try {
  readAgentEnvironment();
  console.log(`Agent settings are present. Required model: ${FREE_MODEL}.`);
  console.log("This checks configuration only. It does not verify keys or call a model.");
  console.log("Start pnpm trigger:dev and the API, then send a message from the frontend. For an isolated connection check, test agent-connection-check with {}.");
} catch (error) {
  console.error(error instanceof AgentConfigurationError ? error.message : "Could not check agent settings.");
  console.error("Add the settings to the backend .env.local. See docs/guides/agent-setup.md. Never paste secret keys into chat.");
  process.exitCode = 1;
}
