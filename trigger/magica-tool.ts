import { triggerApprovals } from "../src/approvals/trigger";
import { schemaTask, wait } from "@trigger.dev/sdk";
import { MEDIA_TASK_ID, MediaTaskPayloadSchema, ToolResultSchema } from "../src/contracts/tools";
import { executeMediaTool } from "../src/tools/execute";

export const magicaTool = schemaTask({
  id: MEDIA_TASK_ID, schema: MediaTaskPayloadSchema, maxDuration: 600,
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  run: async ({ invocationId }, { ctx, signal }) => ToolResultSchema.parse(await executeMediaTool(invocationId, ctx.run.id, async seconds => { await wait.for({ seconds }); }, signal, undefined, triggerApprovals)),
});
