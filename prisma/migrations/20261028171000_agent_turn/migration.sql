-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'stopping', 'completed', 'failed', 'cancelled');

-- AlterEnum
ALTER TYPE "MessageRole" ADD VALUE 'tool';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "error" VARCHAR(300);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "userMessageId" UUID NOT NULL,
    "assistantMessageId" UUID NOT NULL,
    "triggerRunId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "requestedModel" TEXT NOT NULL DEFAULT 'openrouter/free',
    "actualModel" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "applicationCredits" INTEGER NOT NULL DEFAULT 0,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "dispatchAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_userMessageId_key" ON "AgentRun"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_assistantMessageId_key" ON "AgentRun"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_triggerRunId_key" ON "AgentRun"("triggerRunId");

-- CreateIndex
CREATE INDEX "AgentRun_chatId_createdAt_id_idx" ON "AgentRun"("chatId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AgentRun_status_dispatchAfter_idx" ON "AgentRun"("status", "dispatchAfter");

-- CreateIndex
CREATE INDEX "AgentRun_status_startedAt_idx" ON "AgentRun"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_chatId_requestId_key" ON "AgentRun"("chatId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_id_chatId_key" ON "Message"("id", "chatId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userMessageId_chatId_fkey" FOREIGN KEY ("userMessageId", "chatId") REFERENCES "Message"("id", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_assistantMessageId_chatId_fkey" FOREIGN KEY ("assistantMessageId", "chatId") REFERENCES "Message"("id", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- This predicate is the database-level guard, including non-REST writers.
CREATE UNIQUE INDEX "AgentRun_one_active_per_chat" ON "AgentRun" ("chatId") WHERE "status" IN ('queued', 'running', 'stopping');
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_distinct_messages" CHECK ("userMessageId" <> "assistantMessageId");
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_nonnegative_usage" CHECK (("promptTokens" IS NULL OR "promptTokens" >= 0) AND ("completionTokens" IS NULL OR "completionTokens" >= 0) AND "applicationCredits" = 0 AND "sequence" >= 0);
