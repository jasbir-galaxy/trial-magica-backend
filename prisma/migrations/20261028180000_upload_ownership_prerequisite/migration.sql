-- Upload ownership foreign keys precede the credit migration's canonical index.
-- Preserve historical migration checksums and skip this bridge on upgraded databases.
DO $$
BEGIN
  IF to_regclass('"Chat_id_userId_key"') IS NULL THEN
    CREATE UNIQUE INDEX "Chat_upload_owner_key" ON "Chat"("id", "userId");
  END IF;
END $$;
