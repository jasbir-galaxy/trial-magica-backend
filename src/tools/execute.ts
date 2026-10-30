import "server-only";
import { PLAN_TOOL_NAME } from "../contracts/plans";
import { awaitToolApproval, type ApprovalDriver } from "../approvals/store";
import { ensureAccount } from "../credits/store";
import { HttpError } from "../http/errors";
import { z } from "zod";
import { getDatabase } from "../db/client";
import { MediaToolNameSchema, ToolResultSchema } from "../contracts/tools";
import { hashJson, normalizeOutput } from "./registry";
import { createMagicaClient, ToolServiceError, type MagicaClient } from "./magica-client";
import { settleInvocation, toolResult } from "./store";

export const TOOL_POLL_WINDOW_MS = 9 * 60_000;
// Trigger checkpoints waits longer than five seconds instead of billing idle compute.
const TOOL_POLL_INTERVAL_SECONDS = 10;
export async function executeMediaTool(invocationId: string, triggerRunId: string, wait: (seconds: number) => Promise<void>, signal: AbortSignal, client?: MagicaClient, approvals?: ApprovalDriver) {
  const db = getDatabase();
  let row = await db.toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
  if (["completed", "failed", "cancelled", "unknown"].includes(row.status)) return toolResult(row);
  const name = MediaToolNameSchema.parse(row.name);
  const validatePinnedInput = () => {
    if (row.name !== name) throw new Error("Saved tool identity changed.");
    // Revalidate the pinned schema on every retry, even after the live catalog changes.
    if (hashJson(row.inputSchema) !== row.schemaHash || hashJson({ name, subModelId: row.subModelId ?? undefined, input: row.input }) !== row.inputHash) throw new Error("Saved tool schema failed validation.");
    z.fromJSONSchema(row.inputSchema as z.core.JSONSchema.JSONSchema, { defaultTarget: "draft-7" }).parse(row.subModelId ? { subModelId: row.subModelId, input: row.input } : row.input);
  };
  validatePinnedInput();
  try { client ??= createMagicaClient(); } catch (error) {
    return toolResult(await settleInvocation(row.id, "failed", error instanceof ToolServiceError ? error.message : "Media tools are unavailable."));
  }
  if (!row.providerRunId && ["pending", "awaiting_approval"].includes(row.status)) {
    await db.toolInvocation.updateMany({ where: { id: row.id, triggerRunId: null }, data: { triggerRunId } });
    if (!approvals) throw new Error("Media approval transport is required before submission");
    try { await awaitToolApproval(row.id, client, approvals); }
    catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof ToolServiceError)) throw error;
      return toolResult(await settleInvocation(row.id, "failed", error.message));
    }
    row = await db.toolInvocation.findUniqueOrThrow({ where: { id: row.id } });
    validatePinnedInput();
    signal.throwIfAborted();
    if (["completed", "failed", "cancelled", "unknown"].includes(row.status)) return toolResult(row);

    const claim = await db.$transaction(async tx => {
      // Serialize only the short admission step. Unknown starts for these same
      // inputs cannot be silently resubmitted by a later model retry.
      await tx.$queryRaw`SELECT id FROM "Chat" WHERE id = ${row.chatId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${row.runId}::uuid FOR UPDATE`;
      const parent = await tx.agentRun.findUniqueOrThrow({ where: { id: row.runId } });
      if (parent.status !== "running") return "cancelled";
      if (parent.planMode && !await tx.toolInvocation.findFirst({ where: { runId: parent.id, name: PLAN_TOOL_NAME, status: "completed", approval: { status: "approved" } }, select: { id: true } })) return "plan_required";
      await tx.$queryRaw`SELECT id FROM "ToolInvocation" WHERE id = ${row.id}::uuid FOR UPDATE`;
      const approval = await tx.waitpoint.findUnique({ where: { toolId: row.id } });
      const held = await tx.creditReservation.findUnique({ where: { toolId: row.id } });
      if (approval?.status !== "approved" || approval.inputHash !== row.inputHash || !held || held.settledAt) return "busy";
      const account = await ensureAccount(tx, parent.userId);
      if (account.balance < account.reserved) return "unfunded";
      const unresolved = await tx.toolInvocation.findFirst({ where: { chatId: row.chatId, inputHash: row.inputHash, id: { not: row.id }, status: { in: ["submitting", "running", "unknown"] } }, select: { id: true } });
      if (unresolved) return "duplicate";
      const changed = await tx.toolInvocation.updateMany({ where: { id: row.id, status: "awaiting_approval" }, data: { status: "submitting", triggerRunId, startedAt: new Date(), reconcileAfter: new Date(Date.now() + 60_000) } });
      return changed.count ? "claimed" : "busy";
    });
    if (claim === "cancelled") return toolResult(await settleInvocation(row.id, "cancelled", "This tool was stopped before it started."));
    if (claim === "plan_required") return toolResult(await settleInvocation(row.id, "failed", "Approve the saved plan before starting media work."));
    if (claim === "unfunded") return toolResult(await settleInvocation(row.id, "failed", "There are not enough available credits to start this task. Other completed work used the remaining balance; your hold has been released."));
    if (claim === "duplicate") return toolResult(await settleInvocation(row.id, "failed", "An earlier tool with these inputs is still unresolved. Check its result before retrying."));
    if (claim === "claimed") {
      try {
        // Do not abort an accepted POST when the parent is stopped: losing its
        // receipt could duplicate work. Subsequent turns cannot replay this claim.
        const receipt = await client.start(name, row.input as Record<string, unknown>, row.subModelId ?? undefined);
        row = await db.toolInvocation.update({ where: { id: row.id }, data: { providerRunId: receipt.runId, status: "running", error: null } });
      } catch (error) {
        const safe = error instanceof ToolServiceError ? error : new ToolServiceError("UNKNOWN", "The tool may have started. Its receipt could not be saved. Contact support before retrying.");
        return toolResult(await settleInvocation(row.id, safe.code === "UNKNOWN" ? "unknown" : "failed", safe.message));
      }
    }
  }
  row = await db.toolInvocation.findUniqueOrThrow({ where: { id: row.id } });
  if (!row.providerRunId) {
    // Another live worker may still be receiving its receipt. Never steal a POST.
    if (row.status === "submitting" && row.startedAt && Date.now() - row.startedAt.getTime() > 60_000) return toolResult(await settleInvocation(row.id, "unknown", "The tool may have started without a saved receipt. Contact support before retrying."));
    return toolResult(row);
  }
  const deadline = Date.now() + TOOL_POLL_WINDOW_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const result = await client.read(row.providerRunId, signal);
      if (result.nodeType !== name) throw new ToolServiceError("INVALID_RESULT", "The saved media receipt does not match this tool.");
      if (result.status === "COMPLETED") {
        try { return toolResult(await settleInvocation(row.id, "completed", null, result.creditUsed, normalizeOutput(name, result))); }
        catch (error) { if (!(error instanceof z.ZodError)) throw error; return toolResult(await settleInvocation(row.id, "failed", "The tool finished but its output was invalid. Contact support with the saved receipt.", result.creditUsed)); }
      }
      if (result.status === "FAILED" || result.status === "CANCELED") return toolResult(await settleInvocation(row.id, result.status === "CANCELED" ? "cancelled" : "failed", result.status === "CANCELED" ? "The media task was cancelled." : "This media task failed. Check the source files and try again.", result.creditUsed));
      failures = 0;
      await db.toolInvocation.updateMany({ where: { id: row.id, status: "running" }, data: { error: null, reconcileAfter: new Date(Date.now() + 60_000) } });
    } catch (error) {
      if (signal.aborted) throw error;
      failures++;
      const message = error instanceof ToolServiceError ? error.message : "Unable to check this tool. Its receipt is saved for recovery.";
      await db.toolInvocation.updateMany({ where: { id: row.id, status: "running" }, data: { error: message, reconcileAfter: new Date(Date.now() + 60_000) } });
      if (failures >= 5 || (error instanceof ToolServiceError && error.code === "AUTH")) break;
    }
    await wait(Math.min(30, TOOL_POLL_INTERVAL_SECONDS * 2 ** failures));
  }
  await db.toolInvocation.updateMany({ where: { id: row.id, status: "running" }, data: { error: "This tool is taking longer than expected. Its saved receipt will be checked again; do not resubmit it.", reconcileAfter: new Date(Date.now() + 60_000) } });
  return ToolResultSchema.parse({ ok: false, invocationId: row.id, retryable: false, error: "This tool is still being checked. Do not submit it again." });
}
