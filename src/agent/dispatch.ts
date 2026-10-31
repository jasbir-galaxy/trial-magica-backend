import { logEvent, runLogContext } from "../observability/log";
import "server-only";
import { auth, idempotencyKeys, runs, tasks } from "@trigger.dev/sdk";
import type { agentTurn } from "../../trigger/agent-turn";
import { AGENT_TASK_ID, isActiveRun, type Run } from "../contracts/runs";
import { getDatabase } from "../db/client";
import { ACTIVE, finishRun, getOwnedRun, MAX_RUN_AGE_MS } from "./run-store";

export async function dispatchRun(runId: string) {
  const db = getDatabase();
  // The pending database row is an outbox. A short lease bounds retries; an
  // ambiguous network response is retried with the SAME global idempotency key.
  const claim = await db.agentRun.updateMany({ where: { id: runId, status: "queued", triggerRunId: null, dispatchAfter: { lte: new Date() } }, data: { dispatchAfter: new Date(Date.now() + 15_000) } });
  if (!claim.count) return;
  const trace = runLogContext(await db.agentRun.findUniqueOrThrow({ where: { id: runId } }));
  try {
    const handle = await tasks.trigger<typeof agentTurn>(AGENT_TASK_ID, { runId }, {
      idempotencyKey: await idempotencyKeys.create(`agent-turn:${runId}`, { scope: "global" }), idempotencyKeyTTL: "30d", ttl: "3m",
    }, { retry: { maxAttempts: 1 } });
    await db.agentRun.update({ where: { id: runId }, data: { triggerRunId: handle.id } });
    logEvent("info", "Turn dispatched", { ...trace, triggerRunId: handle.id, status: "queued" });
  } catch {
    logEvent("error", "Turn dispatch deferred", trace);
    // Keep the saved message and queued run recoverable; never recreate either.
  }
}

export const RUN_RECONCILE_INTERVAL_MS = 15_000;
export async function reconcileRun(run: Run) {
  if (!isActiveRun(run.status)) return;
  const since = new Date(run.startedAt ?? run.createdAt).getTime();
  if (Date.now() - since > MAX_RUN_AGE_MS) {
    await finishRun(run.id, "failed", "This reply timed out. Your saved messages are safe. Please try again.");
    return;
  }
  if (!run.triggerRunId) { if (run.status === "queued") await dispatchRun(run.id); return; }
  // REST readers and the recovery task share a short per-run lease. A failed
  // worker may have been unable to write its terminal state during a DB outage.
  // Never replay it: reconcile the receipt and preserve PostgreSQL's partial work.
  const claimed = await getDatabase().agentRun.updateMany({
    where: { id: run.id, status: { in: ACTIVE }, dispatchAfter: { lte: new Date() } },
    data: { dispatchAfter: new Date(Date.now() + RUN_RECONCILE_INTERVAL_MS) },
  });
  if (!claimed.count) return;
  let worker: Awaited<ReturnType<typeof runs.retrieve>>;
  try { worker = await runs.retrieve(run.triggerRunId, { retry: { maxAttempts: 1 } }); }
  catch { logEvent("warn", "Worker status temporarily unavailable", { ...runLogContext({ ...run, assistantMessageId: run.assistantMessage.id }), code: "RUN_STATUS_UNAVAILABLE" }); return; }
  if (worker.isCancelled) await finishRun(run.id, "cancelled", "This reply was stopped. Your saved messages and results are safe.");
  else if (worker.isFailed || worker.isCompleted) await finishRun(run.id, "failed", "This reply was interrupted before its final result could be saved. Your saved messages and results are safe. Please try again.");
}

export async function realtimeForRun(userId: string, runId: string) {
  const run = await getOwnedRun(userId, runId);
  if (!run.triggerRunId) return null;
  return { runId: run.triggerRunId, accessToken: await auth.createPublicToken({ scopes: { read: { runs: [run.triggerRunId] } }, expirationTime: "15m" }) };
}
