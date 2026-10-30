import { z } from "zod";
import { AttachmentIdListSchema } from "./uploads";
import { ChatIdSchema, MAX_TEXT_LENGTH, MessageSchema, MessageContentSchema } from "./chats";

export const AGENT_TASK_ID = "agent-turn";
export const TEXT_STREAM_ID = "assistant-text";
// Transport subscriptions must stay below Trigger.dev's 600-second ceiling.
// This is independent of the durable agent task's 30-minute execution bound.
export const TEXT_STREAM_TIMEOUT_SECONDS = 300;
export const FREE_CHAT_MODEL = "openrouter/free";
export const ACTIVE_STATUSES = ["queued", "running", "stopping"] as const;
export const RunStatusSchema = z.enum([...ACTIVE_STATUSES, "completed", "failed", "cancelled"]);
export const SendTurnSchema = z.strictObject({
  requestId: z.uuid(), text: z.string().trim().max(MAX_TEXT_LENGTH),
  model: z.literal(FREE_CHAT_MODEL).default(FREE_CHAT_MODEL),
  attachmentIds: AttachmentIdListSchema.optional(),
  planMode: z.boolean().optional(),
}).refine(value => value.text.length > 0 || !!value.attachmentIds?.length, "Add a message or a file.");
export const RunPayloadSchema = z.strictObject({ runId: z.uuid() });
export const TextFrameSchema = z.strictObject({
  sequence: z.number().int().nonnegative(), text: z.string().max(MAX_TEXT_LENGTH), content: MessageContentSchema.optional(),
});
export const RunMetadataSchema = z.object({
  runId: z.uuid(), status: RunStatusSchema, step: z.enum(["thinking", "writing", "working", "finished"]),
});
export const RunSchema = z.object({
  id: z.uuid(), chatId: ChatIdSchema, requestId: z.uuid(),
  status: RunStatusSchema, triggerRunId: z.string().nullable(),
  userMessage: MessageSchema, assistantMessage: MessageSchema,
  kind: z.enum(["agent", "tool"]).optional(),
  planMode: z.boolean().optional(),
  requestedModel: z.literal(FREE_CHAT_MODEL), actualModel: z.string().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(), completionTokens: z.number().int().nonnegative().nullable(),
  applicationCredits: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  error: z.string().max(300).nullable(), createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
});
export const RunStateSchema = z.object({ run: RunSchema.nullable() });
export const RealtimeSchema = z.object({ runId: z.string(), accessToken: z.string().min(1) });
export const SendTurnResultSchema = z.object({ run: RunSchema, realtime: RealtimeSchema.nullable() });
export type Run = z.infer<typeof RunSchema>;
export type SendTurn = z.infer<typeof SendTurnSchema>;
export type TextFrame = z.infer<typeof TextFrameSchema>;
export type Realtime = z.infer<typeof RealtimeSchema>;
export function isActiveRun(status: Run["status"]) { return (ACTIVE_STATUSES as readonly string[]).includes(status); }
