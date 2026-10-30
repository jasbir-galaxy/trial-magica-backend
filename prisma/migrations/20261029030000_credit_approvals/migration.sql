-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'cancelled');

-- AlterEnum
ALTER TYPE "ToolStatus" ADD VALUE 'awaiting_approval';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "userId" UUID;
UPDATE "AgentRun" r SET "userId" = c."userId" FROM "Chat" c WHERE c.id = r."chatId";
ALTER TABLE "AgentRun" ALTER COLUMN "userId" SET NOT NULL;
CREATE UNIQUE INDEX "Chat_id_userId_key" ON "Chat"("id", "userId");
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_chatId_fkey";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_userId_fkey" FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "CreditAccount" (
    "userId" UUID NOT NULL,
    "balance" BIGINT NOT NULL,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CreditReservation" (
    "id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "userId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "toolId" UUID,
    "amount" BIGINT NOT NULL,
    "actualAmount" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "userId" UUID NOT NULL,
    "reservationId" UUID,
    "kind" VARCHAR(20) NOT NULL,
    "balanceDelta" BIGINT NOT NULL,
    "reservedDelta" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "tokenId" VARCHAR(200),
    "status" "WaitpointStatus" NOT NULL DEFAULT 'pending',
    "inputHash" VARCHAR(64) NOT NULL,
    "estimate" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionRequestId" UUID,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_key_key" ON "CreditReservation"("key");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_toolId_key" ON "CreditReservation"("toolId");

-- CreateIndex
CREATE INDEX "CreditReservation_runId_settledAt_idx" ON "CreditReservation"("runId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_id_userId_key" ON "CreditReservation"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_toolId_runId_key" ON "CreditReservation"("toolId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_key_key" ON "CreditLedger"("key");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_id_idx" ON "CreditLedger"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_toolId_key" ON "Waitpoint"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_tokenId_key" ON "Waitpoint"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_decisionRequestId_key" ON "Waitpoint"("decisionRequestId");

-- CreateIndex
CREATE INDEX "Waitpoint_status_expiresAt_idx" ON "Waitpoint"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Waitpoint_deliveredAt_status_createdAt_idx" ON "Waitpoint"("deliveredAt", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_userId_key" ON "AgentRun"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_id_runId_key" ON "ToolInvocation"("id", "runId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "CreditAccount"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_runId_userId_fkey" FOREIGN KEY ("runId", "userId") REFERENCES "AgentRun"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_toolId_runId_fkey" FOREIGN KEY ("toolId", "runId") REFERENCES "ToolInvocation"("id", "runId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "CreditAccount"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_reservationId_userId_fkey" FOREIGN KEY ("reservationId", "userId") REFERENCES "CreditReservation"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ToolInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditAccount" ADD CONSTRAINT "credit_account_reserved_nonnegative" CHECK (reserved >= 0);
ALTER TABLE "CreditReservation" ADD CONSTRAINT "credit_reservation_nonnegative" CHECK (amount >= 0 AND ("actualAmount" IS NULL OR "actualAmount" >= 0));
ALTER TABLE "CreditLedger" ADD CONSTRAINT "credit_ledger_kind" CHECK (kind IN ('grant', 'reserve', 'settle'));
ALTER TABLE "Waitpoint" ADD CONSTRAINT "waitpoint_estimate_nonnegative" CHECK (estimate >= 0);
