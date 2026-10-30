CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending','delivering','delivered','failed','disabled');
CREATE TABLE "WebhookEndpoint" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "requestId" UUID NOT NULL, "url" VARCHAR(2048) NOT NULL, "events" TEXT[] NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "disabledAt" TIMESTAMPTZ(3),
 UNIQUE("id","userId"), UNIQUE("userId","requestId"),
 CHECK (cardinality("events") BETWEEN 1 AND 5 AND "events" <@ ARRAY['agent.started','agent.completed','agent.failed','agent.cancelled','tool.completed']::text[])
);
CREATE INDEX "WebhookEndpoint_userId_disabledAt_idx" ON "WebhookEndpoint"("userId","disabledAt");
CREATE TABLE "WebhookEvent" (
 "id" UUID PRIMARY KEY, "key" VARCHAR(200) NOT NULL UNIQUE, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "runId" UUID NOT NULL, "type" VARCHAR(40) NOT NULL, "body" VARCHAR(2048) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("id","userId"),
 FOREIGN KEY ("runId","userId") REFERENCES "AgentRun"("id","userId") ON DELETE RESTRICT,
 CHECK ("type" IN ('agent.started','agent.completed','agent.failed','agent.cancelled','tool.completed'))
);
CREATE INDEX "WebhookEvent_runId_idx" ON "WebhookEvent"("runId");
CREATE TABLE "WebhookDelivery" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL, "eventId" UUID NOT NULL, "endpointId" UUID NOT NULL,
 "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "claimId" UUID, "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "responseStatus" INTEGER, "error" VARCHAR(200),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deliveredAt" TIMESTAMPTZ(3),
 UNIQUE("eventId","endpointId"),
 FOREIGN KEY("eventId","userId") REFERENCES "WebhookEvent"("id","userId") ON DELETE RESTRICT,
 FOREIGN KEY("endpointId","userId") REFERENCES "WebhookEndpoint"("id","userId") ON DELETE RESTRICT,
 CHECK ("attempts" >= 0)
);
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_id_idx" ON "WebhookDelivery"("status","nextAttemptAt","id");
CREATE INDEX "WebhookDelivery_endpointId_createdAt_id_idx" ON "WebhookDelivery"("endpointId","createdAt" DESC,"id" DESC);
