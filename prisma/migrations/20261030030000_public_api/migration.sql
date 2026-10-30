CREATE TYPE "RunKind" AS ENUM ('agent', 'tool');
ALTER TABLE "AgentRun" ADD COLUMN "kind" "RunKind" NOT NULL DEFAULT 'agent';
CREATE TABLE "PublicApiKey" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "requestId" UUID NOT NULL, "name" VARCHAR(80) NOT NULL, "prefix" VARCHAR(20) NOT NULL,
 "tokenHash" VARCHAR(64) NOT NULL UNIQUE, "scopes" TEXT[] NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "revokedAt" TIMESTAMPTZ(3), "lastUsedAt" TIMESTAMPTZ(3),
 "windowStart" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "windowCount" INTEGER NOT NULL DEFAULT 0,
 UNIQUE ("userId", "requestId"),
 CONSTRAINT "PublicApiKey_scopes" CHECK (cardinality("scopes") BETWEEN 1 AND 3 AND "scopes" <@ ARRAY['chats:read','runs:write','approvals:write']::text[]),
 CONSTRAINT "PublicApiKey_window" CHECK ("windowCount" >= 0)
);
CREATE INDEX "PublicApiKey_userId_revokedAt_expiresAt_idx" ON "PublicApiKey"("userId", "revokedAt", "expiresAt");
