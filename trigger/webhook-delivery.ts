import { schedules, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { deliverWebhook, recoverWebhookDeliveries } from "../src/webhooks/delivery";
export const webhookAttempt = schemaTask({ id: "webhook-attempt", schema: z.strictObject({ deliveryId: z.uuid() }), maxDuration: 30, retry: { maxAttempts: 1 }, concurrency: { total: 20, perKey: 2 },
 run: async ({ deliveryId }) => { await deliverWebhook(deliveryId); return { checked: deliveryId }; },
});
export const webhookDelivery = schedules.task({ id: "webhook-delivery", cron: { pattern: "* * * * *", window: "5m" }, maxDuration: 60,
 run: async () => recoverWebhookDeliveries(rows => webhookAttempt.batchTrigger(rows.map(row => ({ payload: { deliveryId: row.id }, options: { concurrencyKey: row.endpointId, idempotencyKey: `webhook:${row.id}:${Math.floor(Date.now()/60_000)}`, idempotencyKeyTTL: "5m" } })))),
});
