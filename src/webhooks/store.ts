import "server-only";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { HttpError } from "../http/errors";
import { MAX_WEBHOOK_ENDPOINTS, CreatedWebhookSchema, WebhookEndpointListSchema, WebhookEndpointSchema, WebhookEventSchema, WebhookDeliveryPageSchema, type WebhookEventType, type CreateWebhook } from "../contracts/webhooks";
import { endpointSecret, webhooksConfigured } from "./signature";
import { resolveWebhookTarget, WebhookTargetError } from "./transport";
import { decodeCursor, makePage } from "../chats/pagination";
import type { PageQuery } from "../contracts/chats";
const endpointDto = (row: { createdAt: Date }) => WebhookEndpointSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
export async function createWebhook(clerkUserId: string, input: CreateWebhook) {
  if (!webhooksConfigured()) endpointSecret("configuration-check");
  try { await resolveWebhookTarget(input.url); } catch (error) { throw new HttpError(400, "INVALID_DESTINATION", error instanceof WebhookTargetError ? error.message : "The destination could not be resolved. Try again later."); }
  return getDatabase().$transaction(async tx => {
    await tx.user.createMany({ data: [{ clerkUserId }], skipDuplicates: true });
    const [user] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE "clerkUserId"=${clerkUserId} FOR UPDATE`;
    const prior = await tx.webhookEndpoint.findUnique({ where: { userId_requestId: { userId: user.id, requestId: input.requestId } } });
    if (prior) throw new HttpError(409, "ENDPOINT_ALREADY_CREATED", "This endpoint was already created. If its secret was lost, disable it and create a new endpoint.");
    if (await tx.webhookEndpoint.count({ where: { userId: user.id, disabledAt: null } }) >= MAX_WEBHOOK_ENDPOINTS) throw new HttpError(409, "WEBHOOK_LIMIT", "Disable an unused endpoint before creating another.");
    const row = await tx.webhookEndpoint.create({ data: { userId: user.id, ...input } });
    return CreatedWebhookSchema.parse({ endpoint: endpointDto(row), secret: endpointSecret(row.id) });
  });
}
export async function listWebhooks(clerkUserId: string) {
  return WebhookEndpointListSchema.parse({ configured: webhooksConfigured(), items: (await getDatabase().webhookEndpoint.findMany({ where: { user: { clerkUserId }, disabledAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_WEBHOOK_ENDPOINTS })).map(endpointDto) });
}
export async function disableWebhook(clerkUserId: string, id: string) {
  return getDatabase().$transaction(async tx => {
    const changed = await tx.webhookEndpoint.updateMany({ where: { id, user: { clerkUserId } }, data: { disabledAt: new Date() } });
    if (!changed.count) throw new HttpError(404, "NOT_FOUND", "Webhook endpoint not found.");
    await tx.webhookDelivery.updateMany({ where: { endpointId: id, status: "pending" }, data: { status: "disabled" } });
    return { success: true as const };
  });
}
export async function listDeliveries(clerkUserId: string, endpointId: string, query: PageQuery) {
  const db = getDatabase();
  if (!await db.webhookEndpoint.findFirst({ where: { id: endpointId, user: { clerkUserId } }, select: { id: true } })) throw new HttpError(404, "NOT_FOUND", "Webhook endpoint not found.");
  const scope = `deliveries:${endpointId}`, boundary = decodeCursor(query.cursor, scope);
  const rows = await db.webhookDelivery.findMany({ where: { endpointId, ...(boundary ? { OR: [{ createdAt: { lt: new Date(boundary.createdAt) } }, { createdAt: new Date(boundary.createdAt), id: { lt: boundary.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1, include: { event: { select: { type: true } } } });
  const page = makePage(rows, query.limit, scope);
  return WebhookDeliveryPageSchema.parse({ ...page, items: page.items.map(row => ({ ...row, type: row.event.type, createdAt: row.createdAt.toISOString(), nextAttemptAt: row.nextAttemptAt.toISOString(), deliveredAt: row.deliveredAt?.toISOString() ?? null })) });
}
export async function recordWebhookEvent(tx: Prisma.TransactionClient, type: WebhookEventType, run: { id: string; userId: string; chatId: string; assistantMessageId: string }, status: "running" | "completed" | "failed" | "cancelled", toolId?: string) {
  const endpoints = await tx.webhookEndpoint.findMany({ where: { userId: run.userId, disabledAt: null, events: { has: type } }, take: MAX_WEBHOOK_ENDPOINTS, select: { id: true } });
  if (!endpoints.length) return;
  const key = `${type}:${toolId ?? run.id}`, id = randomUUID();
  const event = WebhookEventSchema.parse({ id, type, createdAt: new Date().toISOString(), data: { chatId: run.chatId, runId: run.id, messageId: run.assistantMessageId, ...(toolId ? { toolId } : {}), status } });
  await tx.webhookEvent.createMany({ data: [{ id, key, userId: run.userId, runId: run.id, type, body: JSON.stringify(event) }], skipDuplicates: true });
  const saved = await tx.webhookEvent.findUniqueOrThrow({ where: { key }, select: { id: true } });
  await tx.webhookDelivery.createMany({ data: endpoints.map(endpoint => ({ userId: run.userId, eventId: saved.id, endpointId: endpoint.id })), skipDuplicates: true });
}
