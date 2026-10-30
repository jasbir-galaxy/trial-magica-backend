ALTER TABLE "Chat" ADD COLUMN "isFavorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
CREATE INDEX "Chat_userId_deletedAt_createdAt_id_idx" ON "Chat" ("userId", "deletedAt", "createdAt" DESC, "id" DESC);
CREATE INDEX "Chat_userId_isFavorite_deletedAt_createdAt_id_idx" ON "Chat" ("userId", "isFavorite", "deletedAt", "createdAt" DESC, "id" DESC);
-- Only visible text blocks are searchable, never tool payloads or private URLs.
CREATE FUNCTION public.chat_message_text(blocks jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT coalesce(string_agg(item->>'text', ' ' ORDER BY position), '')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(blocks) = 'array' THEN blocks ELSE '[]'::jsonb END)
    WITH ORDINALITY AS elements(item, position)
  WHERE item->>'type' = 'text' AND jsonb_typeof(item->'text') = 'string'
$$;
CREATE INDEX "Chat_title_search_idx" ON "Chat" USING GIN (to_tsvector('simple', title));
CREATE INDEX "Message_content_search_idx" ON "Message" USING GIN (to_tsvector('simple', public.chat_message_text(content)));
CREATE INDEX "ToolInvocation_chatId_status_idx" ON "ToolInvocation" ("chatId", status);
CREATE INDEX "UploadBatch_chatId_status_idx" ON "UploadBatch" ("chatId", status);
