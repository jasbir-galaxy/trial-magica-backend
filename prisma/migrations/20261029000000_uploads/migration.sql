-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('created', 'uploading', 'processing', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('uploading', 'processing', 'ready', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "UploadQuota" (
    "month" VARCHAR(7) NOT NULL,
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "UploadQuota_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "manifestHash" VARCHAR(64) NOT NULL,
    "signedParams" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'created',
    "assemblyId" VARCHAR(32),
    "error" VARCHAR(300),
    "reservedBytes" BIGINT NOT NULL,
    "quotaMonth" VARCHAR(7) NOT NULL,
    "quotaSettled" BOOLEAN NOT NULL DEFAULT false,
    "cleanupPending" BOOLEAN NOT NULL DEFAULT false,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMPTZ(3),
    "reconcileAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "uploadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'uploading',
    "objectKey" VARCHAR(200) NOT NULL,
    "providerFileId" VARCHAR(200),
    "md5" VARCHAR(32),
    "error" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "messageId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("messageId","position")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_assemblyId_key" ON "UploadBatch"("assemblyId");

-- CreateIndex
CREATE INDEX "UploadBatch_userId_createdAt_id_idx" ON "UploadBatch"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "UploadBatch_chatId_status_createdAt_idx" ON "UploadBatch"("chatId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "UploadBatch_status_reconcileAfter_idx" ON "UploadBatch"("status", "reconcileAfter");

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_userId_requestId_key" ON "UploadBatch"("userId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_id_userId_key" ON "UploadBatch"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");

-- CreateIndex
CREATE INDEX "Attachment_userId_status_createdAt_id_idx" ON "Attachment"("userId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_id_userId_key" ON "Attachment"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_uploadId_position_key" ON "Attachment"("uploadId", "position");

-- CreateIndex
CREATE INDEX "MessageAttachment_attachmentId_userId_idx" ON "MessageAttachment"("attachmentId", "userId");

-- CreateIndex
CREATE INDEX "MessageAttachment_chatId_userId_idx" ON "MessageAttachment"("chatId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_messageId_attachmentId_key" ON "MessageAttachment"("messageId", "attachmentId");

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_chatId_userId_fkey" FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_quotaMonth_fkey" FOREIGN KEY ("quotaMonth") REFERENCES "UploadQuota"("month") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadId_userId_fkey" FOREIGN KEY ("uploadId", "userId") REFERENCES "UploadBatch"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_chatId_fkey" FOREIGN KEY ("messageId", "chatId") REFERENCES "Message"("id", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_chatId_userId_fkey" FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_userId_fkey" FOREIGN KEY ("attachmentId", "userId") REFERENCES "Attachment"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Bound persisted metadata even when writes bypass the HTTP contract.
ALTER TABLE "UploadQuota" ADD CONSTRAINT "UploadQuota_nonnegative" CHECK ("reservedBytes" >= 0 AND "usedBytes" >= 0);
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_positive_reservation" CHECK ("reservedBytes" > 0 AND "attempts" >= 0);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_file_bounds" CHECK ("size" > 0 AND "size" <= 536870912 AND "position" >= 0 AND "position" < 5);
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_position_bounds" CHECK ("position" >= 0 AND "position" < 5);
CREATE INDEX "UploadBatch_userId_status_createdAt_idx" ON "UploadBatch"("userId", "status", "createdAt");
CREATE INDEX "UploadBatch_cleanupPending_reconcileAfter_idx" ON "UploadBatch"("cleanupPending", "reconcileAfter");
