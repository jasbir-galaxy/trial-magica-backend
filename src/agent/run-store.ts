import { logEvent, runLogContext } from "../observability/log";
import "server-only";
import { recordWebhookEvent } from "../webhooks/store";
import { ATTACHMENT_INCLUDE, attachmentDto } from "../uploads/attachments";
import { closeUnsubmitted } from "../approvals/store";
import { reserve, settleReservation } from "../credits/store";
import { CREDIT_ADMISSION_AMOUNT } from "../contracts/credits";
import { getDatabase } from "../db/client";
import { ACTIVE_STATUSES, RunSchema, type SendTurn } from "../contracts/runs";
import { TOOL_INCLUDE, toolDto } from "../tools/store";
import { ToolOutputSchema, GuidanceOutputSchema } from "../contracts/tools";
import { MessageContentSchema } from "../contracts/chats";
import { HttpError } from "../http/errors";
import type { PreparedTool } from "../tools/registry";
import type { Prisma } from "../generated/prisma/client";

export const RUN_INCLUDE = { userMessage: { include: ATTACHMENT_INCLUDE }, assistantMessage: { include: TOOL_INCLUDE } } as const;
export const ACTIVE = [...ACTIVE_STATUSES];
export const MAX_RUN_AGE_MS = 30 * 60_000;
const dtoMessage = (m: { createdAt: Date; updatedAt: Date }) => ({ ...m, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString() });
export async function runDto(run: Prisma.AgentRunGetPayload<{ include: typeof RUN_INCLUDE }>) {
  return RunSchema.parse({ ...run, applicationCredits: Number(run.applicationCredits), userMessage: { ...dtoMessage(run.userMessage), attachments: await Promise.all(run.userMessage.attachments.map(link => attachmentDto(link.attachment))) }, assistantMessage: { ...dtoMessage(run.assistantMessage), tools: run.assistantMessage.tools.map(toolDto) },
    createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null });
}

export async function createTurn(userId: string, chatId: string, input: SendTurn, directTool?: PreparedTool) {
  const db = getDatabase();
  return db.$transaction(async tx => {
    // A per-chat row lock serializes admission only, never the model call.
    const owned = await tx.$queryRaw<{ id: string; updatedAt: Date; userId: string }[]>`
      SELECT c.id, c."updatedAt", c."userId" FROM "Chat" c JOIN "User" u ON u.id = c."userId"
      WHERE c.id = ${chatId}::uuid AND c."deletedAt" IS NULL AND u."clerkUserId" = ${userId} FOR UPDATE OF c, u`;
    if (!owned.length) throw new HttpError(404, "NOT_FOUND", "Chat not found.");
    const prior = await tx.agentRun.findUnique({ where: { chatId_requestId: { chatId, requestId: input.requestId } }, include: RUN_INCLUDE });
    if (prior) {
      if (prior.kind !== (directTool ? "tool" : "agent") || (directTool && prior.assistantMessage.tools[0]?.inputHash !== directTool.inputHash)) throw new HttpError(409, "CONFLICT", "This request ID already belongs to different work.");
      const content = MessageContentSchema.parse(prior.userMessage.content);
      if (content.filter(b => b.type === "text").map(b => b.text).join("\n") !== input.text || prior.requestedModel !== input.model || prior.planMode !== (input.planMode ?? false) || JSON.stringify(prior.userMessage.attachments.map(a => a.attachmentId)) !== JSON.stringify(input.attachmentIds ?? [])) throw new HttpError(409, "CONFLICT", "This request ID already belongs to another message.");
      return runDto(prior);
    }
    if (await tx.agentRun.findFirst({ where: { chatId, status: { in: ACTIVE } }, select: { id: true } })) {
      throw new HttpError(409, "RUN_ACTIVE", "Wait for the current reply or stop it before sending another message.");
    }
    // A bounded indexed query enforces a simple per-account admission limit.
    const recent = await tx.agentRun.findMany({ where: { chat: { user: { clerkUserId: userId } }, createdAt: { gte: new Date(Date.now() - 60_000) } }, take: 10, select: { id: true } });
    if (recent.length >= 10) throw new HttpError(429, "RATE_LIMITED", "You’ve sent several messages. Please wait a minute and try again.");
    const attachmentIds = input.attachmentIds ?? [];
    const files = await tx.attachment.findMany({ where: { id: { in: attachmentIds }, userId: owned[0].userId, status: "ready" }, take: 5, select: { id: true } });
    if (files.length !== attachmentIds.length) throw new HttpError(400, "ATTACHMENT_UNAVAILABLE", "One or more files are not ready. Finish uploading or remove them before sending.");
    // Keep the pair ordered even when timestamps would otherwise tie.
    const timestamp = Math.max(Date.now(), owned[0].updatedAt.getTime() + 2);
    const user = await tx.message.create({ data: { chatId, role: "user", status: "completed", content: [...(input.text ? [{ type: "text", text: input.text }] : []), ...attachmentIds.map(attachmentId => ({ type: "attachment", attachmentId }))], createdAt: new Date(timestamp) } });
    if (attachmentIds.length) await tx.messageAttachment.createMany({ data: attachmentIds.map((attachmentId, position) => ({ messageId: user.id, chatId, userId: owned[0].userId, attachmentId, position })) });
    const assistant = await tx.message.create({ data: { chatId, role: "assistant", status: "pending", content: [], createdAt: new Date(timestamp + 1) } });
    const run = await tx.agentRun.create({ data: { chatId, userId: owned[0].userId, requestId: input.requestId, userMessageId: user.id, assistantMessageId: assistant.id, kind: directTool ? "tool" : "agent", requestedModel: input.model, planMode: input.planMode ?? false }, include: RUN_INCLUDE });
    if (directTool) {
      const tool = await tx.toolInvocation.create({ data: { ...directTool, runId: run.id, messageId: assistant.id, chatId, callId: "api-direct", position: 0 } });
      await tx.message.update({ where: { id: assistant.id }, data: { content: [{ type: "tool", invocationId: tool.id }] } });
    }
    await reserve(tx, owned[0].userId, run.id, `turn:${run.id}`, CREDIT_ADMISSION_AMOUNT);
    await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date(timestamp + 1) } });
    return runDto(directTool ? await tx.agentRun.findUniqueOrThrow({ where: { id: run.id }, include: RUN_INCLUDE }) : run);
  });
}

export async function getOwnedRun(userId: string, runId: string) {
  const run = await getDatabase().agentRun.findFirst({ where: { id: runId, chat: { deletedAt: null, user: { clerkUserId: userId } } }, include: RUN_INCLUDE });
  if (!run) throw new HttpError(404, "NOT_FOUND", "Run not found.");
  return runDto(run);
}
export async function latestRun(userId: string, chatId: string) {
  const db = getDatabase();
  if (!await db.chat.findFirst({ where: { id: chatId, deletedAt: null, user: { clerkUserId: userId } }, select: { id: true } })) throw new HttpError(404, "NOT_FOUND", "Chat not found.");
  const run = await db.agentRun.findFirst({ where: { chatId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: RUN_INCLUDE });
  return run ? runDto(run) : null;
}

export async function saveProgress(runId: string, text: string | ReturnType<typeof MessageContentSchema.parse>, sequence: number) {
  const content = MessageContentSchema.parse(typeof text === "string" ? (text ? [{ type: "text", text }] : []) : text);
  return getDatabase().$transaction(async tx => {
    const changed = await tx.agentRun.updateMany({ where: { id: runId, status: { in: ["running", "stopping"] }, sequence: { lt: sequence } }, data: { sequence } });
    if (!changed.count) return;
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { assistantMessageId: true } });
    await tx.message.update({ where: { id: run.assistantMessageId }, data: { content, status: "streaming" } });
  });
}

export async function finishRun(runId: string, status: "completed" | "failed" | "cancelled", error: string | null = null,
  usage?: { actualModel: string; promptTokens: number | null; completionTokens: number | null }) {
  const finished = await getDatabase().$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "AgentRun" WHERE id = ${runId}::uuid FOR UPDATE`;
    if (!locked.length || !(ACTIVE as string[]).includes(locked[0].status)) return;
    const final = locked[0].status === "stopping" ? "cancelled" : status;
    const safeError = final === "cancelled" ? (locked[0].status === "stopping" ? "You stopped this reply. You can send another message." : error ?? "You stopped this reply. You can send another message.") : error;
    const run = await tx.agentRun.update({ where: { id: runId }, data: { status: final, error: safeError, finishedAt: new Date(), ...usage } });
    await tx.message.update({ where: { id: run.assistantMessageId }, data: { status: final, error: safeError } });
    await closeUnsubmitted(tx, runId);
    await settleReservation(tx, `turn:${runId}`, 0);
    await recordWebhookEvent(tx, `agent.${final}`, run, final);
    return run;
  });
  if (finished) logEvent(finished.status === "failed" ? "error" : "info", "Turn finished", { ...runLogContext(finished), status: finished.status });
}

export async function stopRun(userId: string, runId: string) {
  await getOwnedRun(userId, runId);
  await getDatabase().agentRun.updateMany({ where: { id: runId, status: { in: ["queued", "running"] } }, data: { status: "stopping" } });
  const run = await getDatabase().agentRun.findUniqueOrThrow({ where: { id: runId } });
  if (!run.startedAt || await getDatabase().toolInvocation.count({ where: { runId } })) await finishRun(runId, "cancelled");
  return getOwnedRun(userId, runId);
}

export async function contextForRun(runId: string) {
  const db = getDatabase();
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { userMessage: true } });
  const rows = await db.message.findMany({ where: { chatId: run.chatId, createdAt: { lte: run.userMessage.createdAt }, status: { in: ["completed", "failed", "cancelled"] }, role: { in: ["user", "assistant"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 40, include: { ...TOOL_INCLUDE, ...ATTACHMENT_INCLUDE } });
  let remaining = 60_000;
  const context: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of rows) {
    const text = (await Promise.all(MessageContentSchema.parse(row.content).map(async b => {
      if (b.type === "text") return b.text;
      if (b.type === "attachment") {
        const link = row.attachments.find(a => a.attachmentId === b.attachmentId);
        if (!link) return "[Attachment unavailable]";
        const file = await attachmentDto(link.attachment);
        return JSON.stringify({ attachment: { name: file.name, mimeType: file.mimeType, url: file.url } });
      }
      if (b.type === "citation") return JSON.stringify({ source: b.url, title: b.title });
      // Activity, reasoning and usage are display/audit records, not new instructions.
      if (b.type !== "tool") return "";
      const tool = row.tools.find(t => t.id === b.invocationId);
      const output = tool?.output ? ToolOutputSchema.parse(tool.output) : undefined;
      // Guidance is selected anew per turn. Never replay entire skill bodies or
      // assets through ordinary chat history into every subsequent prompt.
      const guidance = GuidanceOutputSchema.safeParse(output);
      return JSON.stringify(guidance.success ? { loadedSkill: guidance.data.skill.name, path: guidance.data.skill.path, versionHash: guidance.data.skill.versionHash } : output ?? { toolStatus: tool?.status });
    }))).join("\n");
    if (text.length > remaining) break;
    if (!text) continue;
    remaining -= text.length;
    context.push({ role: row.role as "user" | "assistant", content: text });
  }
  return context.reverse();
}
