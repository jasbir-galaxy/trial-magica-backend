import { logEvent, runLogContext } from "../observability/log";
import "server-only";
import { PLAN_TOOL_NAME, PlanInputSchema, PLAN_APPROVAL_COPY } from "../contracts/plans";
import { getDatabase } from "../db/client";
import { reserve, settleReservation, type Transaction } from "../credits/store";
import { APPROVAL_TIMEOUT_SECONDS, ApprovalSchema, type ApprovalDecision } from "../contracts/credits";
import { HttpError } from "../http/errors";
import type { MagicaClient } from "../tools/magica-client";
import { MediaToolNameSchema } from "../contracts/tools";
import type { Waitpoint } from "../generated/prisma/client";
export type ApprovalDriver = { create(id: string, expiresAt: Date): Promise<string>; wait(tokenId: string): Promise<void>; complete(tokenId: string): Promise<void> };
export const approvalDto = (row: Waitpoint) => ApprovalSchema.parse({ ...row, expiresAt: row.expiresAt.toISOString() });
async function lockTool(tx: Transaction, toolId: string) {
  const found = await tx.toolInvocation.findUniqueOrThrow({ where: { id: toolId } });
  await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${found.runId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ToolInvocation" WHERE id = ${toolId}::uuid FOR UPDATE`;
  return tx.toolInvocation.findUniqueOrThrow({ where: { id: toolId }, include: { run: true, approval: true } });
}
export async function closeUnsubmitted(tx: Transaction, runId: string) {
  // Caller holds AgentRun. Submitted/unknown jobs retain holds until reconciled.
  const rows = await tx.toolInvocation.findMany({ where: { runId, status: { in: ["pending", "awaiting_approval"] } }, take: 8, orderBy: { position: "asc" } });
  for (const row of rows) {
    await tx.toolInvocation.update({ where: { id: row.id }, data: { status: "cancelled", error: "This task was stopped before submission.", finishedAt: new Date() } });
    await tx.waitpoint.updateMany({ where: { toolId: row.id, status: { in: ["pending", "approved"] } }, data: { status: "cancelled", decidedAt: new Date(), deliveredAt: null } });
    await settleReservation(tx, `tool:${row.id}`, 0);
  }
}
async function closeApproval(tx: Transaction, row: Waitpoint, status: "rejected" | "expired" | "cancelled") {
  await tx.waitpoint.update({ where: { id: row.id }, data: { status, decidedAt: new Date(), deliveredAt: null } });
  await tx.toolInvocation.update({ where: { id: row.toolId }, data: { status: "cancelled", finishedAt: new Date(), error: status === "expired" ? (row.kind === "plan" ? PLAN_APPROVAL_COPY.expired : "This approval expired. Send a new message to continue.") : status === "rejected" ? (row.kind === "plan" ? "You declined this plan. Send a message with revised instructions to continue." : "You declined this media task. Send a message with revised settings to continue.") : "This task was stopped before submission." } });
  await settleReservation(tx, `tool:${row.toolId}`, 0);
}
export async function createApproval(toolId: string, client?: MagicaClient) {
  const initial = await getDatabase().toolInvocation.findUniqueOrThrow({ where: { id: toolId }, include: { approval: true } });
  if (initial.approval) return initial.approval;
  const kind = initial.name === PLAN_TOOL_NAME ? "plan" : "media";
  if (kind === "plan") PlanInputSchema.parse(initial.input);
  if (kind === "media" && !client) throw new Error("A media estimate is required.");
  const estimate = kind === "plan" ? 0 : await client!.estimate(MediaToolNameSchema.parse(initial.name), initial.input as Record<string, unknown>, initial.subModelId ?? undefined);
  return getDatabase().$transaction(async tx => {
    const tool = await lockTool(tx, toolId);
    if (tool.approval) return tool.approval;
    if (tool.status !== "pending" || tool.run.status !== "running") return null;
    if (kind === "plan" && !tool.run.planMode) throw new Error("Plan mode is not enabled for this turn.");
    if (kind === "media") await reserve(tx, tool.run.userId, tool.runId, `tool:${toolId}`, estimate, toolId);
    const approval = await tx.waitpoint.create({ data: { toolId, kind, inputHash: tool.inputHash, estimate, expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_SECONDS * 1000) } });
    await tx.toolInvocation.update({ where: { id: toolId }, data: { status: "awaiting_approval" } });
    return approval;
  });
}
export async function expireApproval(id: string, now = new Date()) {
  const found = await getDatabase().waitpoint.findUniqueOrThrow({ where: { id } });
  return getDatabase().$transaction(async tx => {
    const tool = await lockTool(tx, found.toolId), row = tool.approval!;
    if (row.status === "pending" && row.expiresAt <= now) await closeApproval(tx, row, "expired");
    return tx.waitpoint.findUniqueOrThrow({ where: { id } });
  });
}
export async function decideApproval(clerkUserId: string, id: string, input: ApprovalDecision) {
  const found = await getDatabase().waitpoint.findFirst({ where: { id, tool: { run: { user: { clerkUserId } } } } });
  if (!found) throw new HttpError(404, "NOT_FOUND", "Approval not found.");
  return getDatabase().$transaction(async tx => {
    const tool = await lockTool(tx, found.toolId), row = tool.approval!;
    if (row.inputHash !== input.inputHash || row.inputHash !== tool.inputHash) throw new HttpError(409, "STALE_APPROVAL", "The task settings changed. Reload this conversation before approving.");
    if (row.status === input.decision) return row;
    if (row.status !== "pending") throw new HttpError(409, "APPROVAL_CLOSED", "This approval is already closed. Reload the conversation to see its status.");
    if (row.expiresAt <= new Date() || tool.run.status !== "running") {
      await closeApproval(tx, row, tool.run.status === "running" ? "expired" : "cancelled");
      return tx.waitpoint.findUniqueOrThrow({ where: { id } });
    }
    // Store the decision before the external wakeup. Repeated submissions cannot
    // change it; a recovery outbox retries wakeups without re-authorizing work.
    if (input.decision === "rejected") await closeApproval(tx, row, "rejected");
    return tx.waitpoint.update({ where: { id }, data: { status: input.decision, decisionRequestId: input.requestId, decidedAt: new Date() } });
  });
}
export async function deliverApproval(id: string, complete: ApprovalDriver["complete"]) {
  const row = await getDatabase().waitpoint.findUniqueOrThrow({ where: { id }, include: { tool: { include: { run: true } } } });
  const trace = { ...runLogContext(row.tool.run), invocationId: row.toolId, waitpointId: id, waitpointTokenId: row.tokenId ?? undefined };
  if (row.status === "pending" || !row.tokenId || row.deliveredAt) return;
  try {
    await complete(row.tokenId);
    await getDatabase().waitpoint.updateMany({ where: { id, status: row.status }, data: { deliveredAt: new Date() } });
    logEvent("info", "Approval wakeup delivered", { ...trace, status: row.status });
  } catch { logEvent("warn", "Approval wakeup deferred", trace); }
}
export async function awaitToolApproval(toolId: string, client: MagicaClient | undefined, driver: ApprovalDriver) {
  let row = await createApproval(toolId, client);
  if (!row) return;
  if (!row.tokenId) {
    const tokenId = await driver.create(row.id, row.expiresAt);
    await getDatabase().waitpoint.updateMany({ where: { id: row.id, tokenId: null }, data: { tokenId } });
    row = await getDatabase().waitpoint.findUniqueOrThrow({ where: { id: row.id } });
  }
  await deliverApproval(row.id, driver.complete);
  if (row.status === "pending") {
    logEvent("info", "Approval waiting", { waitpointId: row.id, waitpointTokenId: row.tokenId!, invocationId: toolId });
    await driver.wait(row.tokenId!);
  }
  // The authenticated DB decision is authoritative, not token output or model text.
  await expireApproval(row.id);
}
export async function recoverApprovals(complete: ApprovalDriver["complete"]) {
  const db = getDatabase();
  const expired = await db.waitpoint.findMany({ where: { status: "pending", expiresAt: { lte: new Date() } }, orderBy: { expiresAt: "asc" }, take: 50, select: { id: true } });
  for (const row of expired) await expireApproval(row.id);
  const pending = await db.waitpoint.findMany({ where: { status: { not: "pending" }, tokenId: { not: null }, deliveredAt: null }, orderBy: { createdAt: "asc" }, take: 50, select: { id: true } });
  for (const row of pending) await deliverApproval(row.id, complete);
  return { expired: expired.length, wakeups: pending.length };
}
