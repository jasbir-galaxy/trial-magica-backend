# Webhook delivery

Lifecycle events are inserted in the same PostgreSQL transaction as run claims,
terminal finalization or tool settlement. Only currently subscribed endpoints
receive events; there is no historical backfill. Event payloads contain IDs and
status, not prompts, files, URLs, keys or full responses. Read the owned run API
for results. A unique event key and event/endpoint constraint deduplicate enqueue.

The Trigger.dev `webhook-delivery` scheduler dispatches at most 500 due deliveries
per minute to typed `webhook-attempt` tasks, with total concurrency 20 and
per-endpoint concurrency 2, subject to account limits. A conditional lease and
claim ID prevent concurrent
workers or stale responses from overwriting another attempt. Delivery is at least
once, not exactly once; consumers deduplicate the event ID. Order is not guaranteed.
Timeouts, connection errors, 408, 429 and 5xx retry up to eight attempts with
bounded exponential backoff. Other responses, including redirects, fail terminally.
An expired final lease becomes visibly failed rather than remaining stuck.

Destinations require public HTTPS on port 443. DNS A records are checked before
creation and every send; private/reserved addresses are rejected, and the selected
address is pinned to a fresh HTTPS connection with hostname verification intact.
IPv6-only destinations are currently unsupported. No redirects are followed.
Disabling an endpoint prevents queued/new sends; a request already in flight may
still arrive. Delivery status and safe errors are available through owned,
cursor-paginated management routes.

Configure WEBHOOK_MASTER_KEY as 32 random bytes encoded in standard base64, in
both backend and worker. Never log it. Per-endpoint secrets are derived with HMAC
and shown once on creation. Keep the master stable: changing it invalidates all
existing endpoint secrets. Rotate an endpoint by creating a replacement and
disabling the old one. Receiver signature/replay examples are in the Mintlify site.

## Migration and rollback

Apply `20261030031000_webhook_outbox` and regenerate Prisma before deploying API
or workers. It only adds tables and relationships; existing chats and tools need
no data conversion. Existing clients are unaffected. Public-API migration must
be applied first. Enable the master key in both processes and deploy the new
scheduled task before registering endpoints.

Rollback: disable registration and endpoints, stop/drain delivery workers, export
delivery receipts, and revert event writers and readers together. Prefer leaving
the additive tables for diagnosis. Destructive rollback, after all dependent
code is removed: DROP TABLE "WebhookDelivery"; DROP TABLE "WebhookEvent";
DROP TABLE "WebhookEndpoint"; DROP TYPE "WebhookDeliveryStatus". Dropping them
loses event/receipt history and requires receiver registration again.

No database transaction stays open during HTTP delivery. A new minute can redispatch an interrupted attempt; the database lease prevents simultaneous sends. Free-tier task rate and concurrency limits still bound actual throughput; production load testing remains required.
