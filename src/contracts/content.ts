import { z } from "zod";

export const MAX_TEXT_LENGTH = 32_000;
export const MAX_REASONING_LENGTH = 32_000;
export const MAX_CONTENT_BLOCKS = 100;
export const MAX_CITATIONS = 30;
export const ReasoningFormatSchema = z.enum(["text", "summary"]);
export const CitationBlockSchema = z.strictObject({
  type: z.literal("citation"),
  url: z.url().max(4096).refine(value => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, "Use an HTTP or HTTPS source URL without credentials."),
  title: z.string().min(1).max(500),
  startIndex: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
  endIndex: z.number().int().min(0).max(MAX_TEXT_LENGTH).optional(),
}).refine(value => (value.startIndex === undefined && value.endIndex === undefined) ||
  (value.startIndex !== undefined && value.endIndex !== undefined && value.endIndex >= value.startIndex), "Citation offsets must form a complete ordered range.");
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(MAX_TEXT_LENGTH) }),
  z.strictObject({ type: z.literal("tool"), invocationId: z.uuid() }),
  z.strictObject({ type: z.literal("attachment"), attachmentId: z.uuid() }),
  // Measured activity, never fabricated model reasoning. Null means still active.
  z.strictObject({ type: z.literal("thinking"), startedAt: z.iso.datetime(), durationMs: z.number().int().nonnegative().nullable() }),
  z.strictObject({ type: z.literal("reasoning"), text: z.string().min(1).max(MAX_REASONING_LENGTH), format: ReasoningFormatSchema }),
  CitationBlockSchema,
  z.strictObject({ type: z.literal("usage"), actualModel: z.string().min(1).max(200),
    promptTokens: z.number().int().nonnegative().nullable(), completionTokens: z.number().int().nonnegative().nullable(), applicationCredits: z.literal(0) }),
]);
export const MessageContentSchema = z.array(ContentBlockSchema).max(MAX_CONTENT_BLOCKS);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type CitationBlock = z.infer<typeof CitationBlockSchema>;
export type ReasoningFormat = z.infer<typeof ReasoningFormatSchema>;
