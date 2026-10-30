import { z } from "zod";
export const MAX_WEBHOOK_ENDPOINTS = 5;
export const WEBHOOK_EVENTS = ["agent.started", "agent.completed", "agent.failed", "agent.cancelled", "tool.completed"] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENTS);
export const WebhookUrlSchema = z.url().max(2048).refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(u.hostname) && !/\.(local|localhost|internal)$/i.test(u.hostname);
}, "Use a public HTTPS endpoint on port 443 without credentials or fragments.");
export const CreateWebhookSchema = z.strictObject({ requestId: z.uuid(), url: WebhookUrlSchema, events: z.array(WebhookEventTypeSchema).min(1).max(WEBHOOK_EVENTS.length).refine(v => new Set(v).size === v.length) });
export const WebhookEndpointSchema = z.object({ id: z.uuid(), url: WebhookUrlSchema, events: z.array(WebhookEventTypeSchema), createdAt: z.iso.datetime() });
export const WebhookEndpointListSchema = z.object({ items: z.array(WebhookEndpointSchema).max(MAX_WEBHOOK_ENDPOINTS), configured: z.boolean() });
export const CreatedWebhookSchema = z.object({ endpoint: WebhookEndpointSchema, secret: z.string().regex(/^whsec_[A-Za-z0-9_-]{43}$/) });
export const WebhookEventSchema = z.strictObject({ id: z.uuid(), type: WebhookEventTypeSchema, createdAt: z.iso.datetime(), data: z.strictObject({ chatId: z.uuid(), runId: z.uuid(), messageId: z.uuid(), toolId: z.uuid().optional(), status: z.enum(["running", "completed", "failed", "cancelled"]) }) });
export const WebhookDeliverySchema = z.object({ id: z.uuid(), eventId: z.uuid(), type: WebhookEventTypeSchema, status: z.enum(["pending", "delivering", "delivered", "failed", "disabled"]), attempts: z.number().int().nonnegative(), responseStatus: z.number().int().nullable(), error: z.string().nullable(), createdAt: z.iso.datetime(), nextAttemptAt: z.iso.datetime(), deliveredAt: z.iso.datetime().nullable() });
export const WebhookDeliveryPageSchema = z.object({ items: z.array(WebhookDeliverySchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
export type CreateWebhook = z.infer<typeof CreateWebhookSchema>;
