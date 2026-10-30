import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

// Safe onboarding probe: no database writes, external calls, or model usage.
export const bootstrapCheck = schemaTask({
  id: "trial-bootstrap-check",
  schema: z.object({ message: z.string().trim().min(1).max(120) }).strict(),
  maxDuration: 10,
  retry: { maxAttempts: 1 },
  run: async ({ message }) => ({ ok: true, message }),
});
