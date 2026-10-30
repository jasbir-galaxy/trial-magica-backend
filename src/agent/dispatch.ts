import "server-only";
import { auth, idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { agentTurn } from "../../trigger/agent-turn";
import { AGENT_TASK_ID, isActiveRun, type Run } from "../contracts/runs";
import { getDatabase } from "../db/client";
import { finishRun, getOwnedRun, MAX_RUN_AGE_MS } from "./run-store";

export async function dispatchRun(runId: string) {
  const db = getDatabase();
  // The pending database row is an outbox. A short lease bounds retries; an
  // ambiguous network response is retried with the SAME global idempotency key.
  const claim = await db.agentRun.updateMany({ where: { id: runId, status: "queued", triggerRunId: null, dispatchAfter: { lte: new Date() } }, data: { dispatchAfter: new Date(Date.now() + 15_000) } });
  if (!claim.count) return;
  try {
    const handle = await tasks.trigger<typeof agentTurn>(AGENT_TASK_ID, { runId }, {
      idempotencyKey: await idempotencyKeys.create(`agent-turn:${runId}`, { scope: "global" }), idempotencyKeyTTL: "30d", ttl: "3m",
    }, { retry: { maxAttempts: 1 } });
    await db.agentRun.update({ where: { id: runId }, data: { triggerRunId: handle.id } });
  } catch {
    console.error("Turn dispatch deferred", { runId });
    // Keep the saved message and queued run recoverable; never recreate either.
  }
}

export async function reconcileRun(run: Run) {
  if (!isActiveRun(run.status)) return;
  const since = new Date(run.startedAt ?? run.createdAt).getTime();
  if (Date.now() - since > MAX_RUN_AGE_MS) {
    await finishRun(run.id, "failed", "This reply timed out. Your saved messages are safe. Please try again.");
  } else if (run.status === "queued") await dispatchRun(run.id);
}

export async function realtimeForRun(userId: string, runId: string) {
  const run = await getOwnedRun(userId, runId);
  if (!run.triggerRunId) return null;
  return { runId: run.triggerRunId, accessToken: await auth.createPublicToken({ scopes: { read: { runs: [run.triggerRunId] } }, expirationTime: "15m" }) };
}
