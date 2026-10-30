import "server-only";
import { claimRun } from "./claim-run";
import { getDatabase } from "../db/client";
import { finishRun } from "./run-store";
import type { ExecuteTools } from "./execute-turn";
export async function executeDirectTurn(runId: string, triggerRunId: string, execute: ExecuteTools) {
  const db = getDatabase();
  const claim = await claimRun(runId, triggerRunId, "tool");
  if (!claim) return { runId, duplicate: true };
  try {
    const tool = await db.toolInvocation.findFirstOrThrow({ where: { runId, callId: "api-direct" } });
    const [result] = await execute([tool.id]);
    await finishRun(runId, result.ok ? "completed" : "failed", result.ok ? null : result.error);
    return { runId, status: (await db.agentRun.findUniqueOrThrow({ where: { id: runId } })).status };
  } catch {
    await finishRun(runId, "failed", "This tool run was interrupted. Check its saved receipt before retrying.");
    throw new Error("Direct tool run interrupted.");
  }
}
