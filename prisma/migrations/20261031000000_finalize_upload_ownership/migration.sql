-- Rebind upload ownership to the canonical index after the credit migration.
-- The DO block is atomic: ownership enforcement never disappears between commits.
DO $$
BEGIN
  IF to_regclass('"Chat_upload_owner_key"') IS NOT NULL THEN
    ALTER TABLE "UploadBatch" DROP CONSTRAINT "UploadBatch_chatId_userId_fkey";
    ALTER TABLE "MessageAttachment" DROP CONSTRAINT "MessageAttachment_chatId_userId_fkey";
    -- AgentRun may also have selected the earlier compatible index.
    ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_chatId_userId_fkey";
    DROP INDEX "Chat_upload_owner_key";
    ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_chatId_userId_fkey"
      FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
    ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_chatId_userId_fkey"
      FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
    ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_userId_fkey"
      FOREIGN KEY ("chatId", "userId") REFERENCES "Chat"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
