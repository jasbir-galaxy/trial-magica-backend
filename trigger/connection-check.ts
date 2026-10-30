import { metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { checkOpenRouterConnection } from "../src/agent/check-connection";

// A development readiness check, not the chat orchestrator. No application data
// is read or persisted; only a fixed probe reaches the mandatory free model route.
export const connectionCheck = schemaTask({
  id: "agent-connection-check",
  schema: z.object({}).strict(),
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (_payload, { signal }) => {
    metadata.set("status", "checking");
    try {
      const result = await checkOpenRouterConnection({ signal });
      metadata.set("status", "complete");
      return result;
    } catch (error) {
      metadata.set("status", signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  },
});
