import { z } from "zod";
import { MessageContentSchema } from "./content";
export { ContentBlockSchema, MessageContentSchema, MAX_CONTENT_BLOCKS, MAX_TEXT_LENGTH } from "./content";
import { AttachmentSchema, MAX_ATTACHMENTS } from "./uploads";
import { ToolInvocationSchema, MAX_TOOL_CALLS } from "./tools";

export const CHATS_PATH = "/api/app/v1/chats";
export const DEFAULT_CHAT_TITLE = "New chat";
export const MAX_CHAT_TITLE_LENGTH = 120;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_CHAT_SEARCH_LENGTH = 120;
export const CHAT_VIEWS = [{ value: "all", label: "All chats" }, { value: "favorites", label: "Favorites" }, { value: "trash", label: "Trash" }] as const;
export const ChatViewSchema = z.enum(["all", "favorites", "trash"]);
export type ChatView = z.infer<typeof ChatViewSchema>;
export const ChatSearchSchema = z.string().trim().max(MAX_CHAT_SEARCH_LENGTH);
export const FavoriteChatSchema = z.strictObject({ isFavorite: z.boolean() });
export const DeleteChatResultSchema = z.object({ id: z.uuid(), deletedAt: z.iso.datetime() });

export const ChatIdSchema = z.uuid();
export const CreateChatSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_CHAT_TITLE_LENGTH).default(DEFAULT_CHAT_TITLE),
  // Reuse this value when retrying the same creation request.
  requestId: z.uuid().optional(),
});
export const PageQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
    .pipe(z.number().int().max(MAX_PAGE_SIZE)).optional().default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
});
export const ChatListQuerySchema = PageQuerySchema.extend({ q: ChatSearchSchema.optional(), view: ChatViewSchema.optional() });
export type ChatListQuery = z.infer<typeof ChatListQuerySchema>;
export const MessagePageQuerySchema = PageQuerySchema.extend({ order: z.enum(["asc", "desc"]).default("asc") });
export type MessagePageQuery = z.infer<typeof MessagePageQuerySchema>;
export const ChatSchema = z.object({
  id: ChatIdSchema,
  title: z.string().min(1).max(MAX_CHAT_TITLE_LENGTH),
  isFavorite: z.boolean().default(false),
  deletedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const MessageSchema = z.object({
  id: z.uuid(),
  chatId: ChatIdSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  status: z.enum(["pending", "streaming", "completed", "failed", "cancelled"]),
  content: MessageContentSchema,
  attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS).optional(),
  tools: z.array(ToolInvocationSchema).max(MAX_TOOL_CALLS).optional(),
  error: z.string().max(300).nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const ChatPageSchema = z.object({
  items: z.array(ChatSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(),
});
export const MessagePageSchema = z.object({
  items: z.array(MessageSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(),
});
export type CreateChat = z.infer<typeof CreateChatSchema>;
export type PageQuery = z.infer<typeof PageQuerySchema>;
export type Chat = z.infer<typeof ChatSchema>;
export type Message = z.infer<typeof MessageSchema>;
