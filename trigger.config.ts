import { loadEnvConfig } from "@next/env";
import { additionalFiles } from "@trigger.dev/build/extensions/core";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { defineConfig } from "@trigger.dev/sdk";

loadEnvConfig(process.cwd(), true);

// Keep the CLI config dependency-light. Its configuration loader cannot load
// this project's Zod 4 module; agent:check and task boundaries validate settings.
const project = process.env.TRIGGER_PROJECT_REF;
if (!project) throw new Error("Set TRIGGER_PROJECT_REF in the backend .env.local, then run pnpm agent:check.");

export default defineConfig({
  project,
  dirs: ["./trigger"],
  legacyDevProcessCwdBehaviour: false,
  build: { conditions: ["react-server"], extensions: [prismaExtension({ mode: "modern" }), additionalFiles({ files: ["./agent-skills/**"] })] },
  maxDuration: 60,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1 },
  },
});
