import "server-only";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { WebhookEventSchema } from "../contracts/webhooks";
import { endpointSecret, webhookSignature } from "./signature";
import { sendWebhook, WebhookTargetError, type WebhookTransport } from "./transport";
export const MAX_WEBHOOK_ATTEMPTS = 8;
export async function deliverWebhook(id: string, transport: WebhookTransport = sendWebhook) {
  const db = getDatabase(), now = new Date(), claimId = randomUUID();
  const claim = await db.webhookDelivery.updateMany({ where: { id, status: { in: ["pending", "delivering"] }, nextAttemptAt: { lte: now }, attempts: { lt: MAX_WEBHOOK_ATTEMPTS } }, data: { status: "delivering", attempts: { increment: 1 }, claimId, nextAttemptAt: new Date(now.getTime() + 60_000) } });
  if (!claim.count) return;
  const row = await db.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { endpoint: true, event: true } });
  const complete = (data: Parameters<typeof db.webhookDelivery.updateMany>[0]["data"]) => db.webhookDelivery.updateMany({ where: { id, claimId, status: "delivering" }, data });
  if (row.endpoint.disabledAt) { await complete({ status: "disabled", claimId: null }); return; }
  let responseStatus: number | null = null, retryable = true, error = "The endpoint could not be reached. Delivery will be retried.";
  try {
    const event = WebhookEventSchema.parse(JSON.parse(row.event.body));
    if (event.id !== row.eventId) throw new Error("Invalid saved event");
    responseStatus = await transport(row.endpoint.url, row.event.body, { "X-Magica-Event-Id": event.id, "X-Magica-Signature": webhookSignature(endpointSecret(row.endpointId), event.id, row.event.body) });
    if (responseStatus >= 200 && responseStatus < 300) { await complete({ status: "delivered", deliveredAt: new Date(), responseStatus, error: null, claimId: null }); return; }
    retryable = responseStatus === 408 || responseStatus === 429 || responseStatus >= 500;
    error = retryable ? "The endpoint is temporarily unavailable." : "The endpoint rejected this delivery. Check its URL and handler.";
  } catch (caught) { if (caught instanceof WebhookTargetError) { retryable = false; error = "The endpoint destination is not allowed."; } }
  const failed = !retryable || row.attempts >= MAX_WEBHOOK_ATTEMPTS;
  await complete({ status: failed ? "failed" : "pending", responseStatus, error: failed && retryable ? "Delivery attempts were exhausted. Check your endpoint before sending new work." : error, claimId: null, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** (row.attempts - 1))) });
}
export async function recoverWebhookDeliveries(dispatch: (rows: { id: string; endpointId: string }[]) => Promise<unknown>) {
  const db = getDatabase(), now = new Date();
  // A crash during the final attempt must not leave a permanent leased row.
  await db.webhookDelivery.updateMany({ where: { status: "delivering", nextAttemptAt: { lte: now }, attempts: { gte: MAX_WEBHOOK_ATTEMPTS } }, data: { status: "failed", claimId: null, error: "The last delivery was interrupted. The endpoint may have received it." } });
  const rows = await db.webhookDelivery.findMany({ where: { status: { in: ["pending", "delivering"] }, nextAttemptAt: { lte: now }, attempts: { lt: MAX_WEBHOOK_ATTEMPTS } }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], take: 500, select: { id: true, endpointId: true } });
  if (rows.length) await dispatch(rows);
  return { checked: rows.length };
}
