-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('pending', 'submitting', 'running', 'completed', 'failed', 'cancelled', 'unknown');

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "callId" VARCHAR(200) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "ToolStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "schemaHash" VARCHAR(64) NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "subModelId" TEXT,
    "providerRunId" TEXT,
    "triggerRunId" TEXT,
    "output" JSONB,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "reconcileAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_providerRunId_key" ON "ToolInvocation"("providerRunId");

-- CreateIndex
CREATE INDEX "ToolInvocation_messageId_position_idx" ON "ToolInvocation"("messageId", "position");

-- CreateIndex
CREATE INDEX "ToolInvocation_status_reconcileAfter_idx" ON "ToolInvocation"("status", "reconcileAfter");

-- CreateIndex
CREATE INDEX "ToolInvocation_chatId_inputHash_status_idx" ON "ToolInvocation"("chatId", "inputHash", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_callId_key" ON "ToolInvocation"("runId", "callId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_position_key" ON "ToolInvocation"("runId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_assistantMessageId_chatId_key" ON "AgentRun"("id", "assistantMessageId", "chatId");

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_messageId_chatId_fkey" FOREIGN KEY ("runId", "messageId", "chatId") REFERENCES "AgentRun"("id", "assistantMessageId", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_messageId_chatId_fkey" FOREIGN KEY ("messageId", "chatId") REFERENCES "Message"("id", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tool usage can exceed zero. The free LLM route itself still costs zero.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_nonnegative_usage";
ALTER TABLE "AgentRun" ALTER COLUMN "applicationCredits" TYPE BIGINT;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_nonnegative_usage" CHECK (("promptTokens" IS NULL OR "promptTokens" >= 0) AND ("completionTokens" IS NULL OR "completionTokens" >= 0) AND "applicationCredits" >= 0 AND "sequence" >= 0);
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_valid_accounting" CHECK ("credits" >= 0 AND "position" >= 0 AND "position" < 8 AND ("durationMs" IS NULL OR "durationMs" >= 0));
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_known_name" CHECK ("name" IN ('crop_image', 'gpt_image_2', 'merge_videos'));
