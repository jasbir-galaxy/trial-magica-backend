import "server-only";
import { getDatabase } from "../db/client";
import { recordWebhookEvent } from "../webhooks/store";
export async function claimRun(runId: string, triggerRunId: string, kind: "agent" | "tool") {
  return getDatabase().$transaction(async tx => {
    const changed = await tx.agentRun.updateMany({ where: { id: runId, kind, status: "queued" }, data: { status: "running", startedAt: new Date(), triggerRunId } });
    if (!changed.count) return false;
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    await recordWebhookEvent(tx, "agent.started", run, "running"); return true;
  });
}
