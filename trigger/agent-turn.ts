import { idempotencyKeys, metadata, schemaTask, streams } from "@trigger.dev/sdk";
import { AGENT_TASK_ID, RunPayloadSchema, TEXT_STREAM_ID, type TextFrame } from "../src/contracts/runs";
import { createOpenRouterModel } from "../src/agent/openrouter";
import { executeTurn } from "../src/agent/execute-turn";
import { finishRun } from "../src/agent/run-store";

import { triggerApprovals } from "../src/approvals/trigger";
import { magicaTool } from "./magica-tool";
import { ToolResultSchema } from "../src/contracts/tools";

import { getDatabase } from "../src/db/client";
import { executeDirectTurn } from "../src/agent/execute-direct-turn";
import type { ExecuteTools } from "../src/agent/execute-turn";
import { getSkillRegistry } from "../src/skills/registry";

const textStream = streams.define<TextFrame>({ id: TEXT_STREAM_ID });
export const agentTurn = schemaTask({
  id: AGENT_TASK_ID, schema: RunPayloadSchema, maxDuration: 1800, retry: { maxAttempts: 1 },
  init: async () => { await getSkillRegistry(); },
  run: async ({ runId }, { signal, ctx }) => {
    const executeTools: ExecuteTools = async ids => {
          const batch = await magicaTool.batchTriggerAndWait(await Promise.all(ids.map(async invocationId => ({
            payload: { invocationId }, options: { idempotencyKey: await idempotencyKeys.create(`media-tool:${invocationId}`, { scope: "global" }), idempotencyKeyTTL: "30d" },
          }))));
          return batch.runs.map((result, index) => result.ok ? ToolResultSchema.parse(result.output) : { ok: false as const, invocationId: ids[index], retryable: false, error: "This tool was interrupted. Its saved receipt will be checked again." });
        };
    if ((await getDatabase().agentRun.findUniqueOrThrow({ where: { id: runId }, select: { kind: true } })).kind === "tool") return executeDirectTurn(runId, ctx.run.id, executeTools);
    let output: Awaited<ReturnType<typeof executeTurn>> | undefined;
    let executionError: unknown;
    let bytesPublished = 0;
    const writer = textStream.writer({ execute: async ({ write }) => {
      try {
        output = await executeTurn(runId, ctx.run.id, createOpenRouterModel(), signal, frame => {
          // Bound even the legacy transport below its 10MB limit. Durable REST
          // snapshots keep updating after the transport budget is exhausted.
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (bytesPublished + bytes <= 8_000_000) { write(frame); bytesPublished += bytes; }
        }, value => { metadata.replace(value); }, executeTools, undefined, undefined, triggerApprovals);
      } catch (error) { executionError = error; }
    } });
    await writer.waitUntilComplete();
    // SDK writer callbacks absorb exceptions; propagate execution failure explicitly.
    if (executionError) throw executionError;
    return output;
  },
  onFailure: async ({ payload }) => { await finishRun(payload.runId, "failed", "This reply could not finish. Your saved messages are safe. Please try again."); },
  onCancel: async ({ payload, runPromise }) => {
    try { await runPromise; } finally { await finishRun(payload.runId, "cancelled"); }
  },
});
