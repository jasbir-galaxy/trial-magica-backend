import "server-only";
import { recordWebhookEvent } from "../webhooks/store";
import { PLAN_TOOL_NAME } from "../contracts/plans";
import { MediaToolNameSchema } from "../contracts/tools";
import { settleReservation } from "../credits/store";
import { approvalDto } from "../approvals/store";
import { getDatabase } from "../db/client";
import { ToolInvocationSchema, ToolOutputSchema, ToolResultSchema, MAX_TOOL_CALLS, type ToolResult, type ToolOutput } from "../contracts/tools";
import type { PreparedTool } from "./registry";
import type { ToolInvocation, Waitpoint } from "../generated/prisma/client";

export const TOOL_INCLUDE = { tools: { orderBy: { position: "asc" as const }, take: MAX_TOOL_CALLS, include: { approval: true } } };
export function toolDto(row: ToolInvocation & { approval?: Waitpoint | null }) {
  return ToolInvocationSchema.parse({ ...row, approval: row.approval ? approvalDto(row.approval) : null, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null });
}
export function toolResult(row: ToolInvocation): ToolResult {
  return ToolResultSchema.parse(row.status === "completed" ? { ok: true, invocationId: row.id, output: row.output } : {
    ok: false, invocationId: row.id, error: row.error ?? (row.status === "cancelled" ? "This tool was stopped before it started." : "This tool is still being checked. Do not submit it again."),
    retryable: row.status === "failed" && !row.providerRunId,
  });
}
export async function registerInvocation(runId: string, callId: string, prepared: PreparedTool) {
  const db = getDatabase();
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${runId}::uuid FOR UPDATE`;
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    const existing = await tx.toolInvocation.findUnique({ where: { runId_callId: { runId, callId } } });
    if (existing) {
      if (existing.inputHash !== prepared.inputHash || existing.name !== prepared.name) throw new Error("A tool call ID cannot be reused with different inputs.");
      return existing;
    }
    // A model can emit the same work under a new call ID. Reuse the invocation
    // within this turn; a new conversation turn can intentionally request a new job.
    const sameWork = await tx.toolInvocation.findFirst({ where: { runId, inputHash: prepared.inputHash, name: prepared.name }, orderBy: { position: "asc" } });
    if (sameWork) return sameWork;
    if (run.status !== "running") throw new Error("This reply has stopped.");
    // Plan consent is a server invariant, never a model instruction alone.
    if (run.planMode && MediaToolNameSchema.safeParse(prepared.name).success && !await tx.toolInvocation.findFirst({ where: { runId, name: PLAN_TOOL_NAME, status: "completed", approval: { status: "approved" } }, select: { id: true } })) throw new Error("Approve the saved plan before starting media work.");
    if (prepared.name === PLAN_TOOL_NAME && (!run.planMode || await tx.toolInvocation.findFirst({ where: { runId, name: PLAN_TOOL_NAME }, select: { id: true } }))) throw new Error("This turn cannot accept another plan.");
    const position = await tx.toolInvocation.count({ where: { runId } });
    if (position >= MAX_TOOL_CALLS) throw new Error("This reply reached its tool limit. Send a follow-up to continue.");
    return tx.toolInvocation.create({ data: { runId, messageId: run.assistantMessageId, chatId: run.chatId, callId, position, ...prepared } });
  });
}
export async function settleInvocation(id: string, status: "completed" | "failed" | "cancelled" | "unknown", error: string | null, credits = 0, output?: ToolOutput) {
  if (output) ToolOutputSchema.parse(output);
  const found = await getDatabase().toolInvocation.findUniqueOrThrow({ where: { id } });
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${found.runId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ToolInvocation" WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.toolInvocation.findUniqueOrThrow({ where: { id } });
    if (["completed", "failed", "cancelled", "unknown"].includes(row.status)) return row;
    const saved = await tx.toolInvocation.update({ where: { id }, data: { status, error, credits, ...(output ? { output } : {}), finishedAt: new Date(), durationMs: Math.max(0, Date.now() - (row.startedAt ?? row.createdAt).getTime()) } });
    if (status !== "unknown") await settleReservation(tx, `tool:${id}`, credits);
    // The terminal row lock is the settlement receipt: duplicate polling cannot
    // increment the turn twice. OpenRouter usage remains zero application credits.
    if (credits) await tx.agentRun.update({ where: { id: row.runId }, data: { applicationCredits: { increment: credits } } });
    if (status === "completed") await recordWebhookEvent(tx, "tool.completed", await tx.agentRun.findUniqueOrThrow({ where: { id: row.runId } }), "completed", row.id);
    return saved;
  });
}
