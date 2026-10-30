import { z } from "zod";
import { PLAN_TOOL_NAME, PlanOutputSchema } from "./plans";
import { ApprovalSchema } from "./credits";
import { SkillTextSchema, SkillReceiptSchema } from "./skills";

export const MEDIA_TASK_ID = "magica-tool";
export const MAX_TOOL_CALLS = 8;
export const MAX_AGENT_STEPS = 6;
export const MAX_INPUT_CORRECTIONS = 2;
export const MAX_TOOL_INPUT_BYTES = 48_000;
export const MediaToolNameSchema = z.enum(["crop_image", "gpt_image_2", "merge_videos"]);
export const ToolNameSchema = z.enum([...MediaToolNameSchema.options, "load_skill", "read_skill_asset", PLAN_TOOL_NAME]);
export type MediaToolName = z.infer<typeof MediaToolNameSchema>;
export const ToolStatusSchema = z.enum(["pending", "awaiting_approval", "submitting", "running", "completed", "failed", "cancelled", "unknown"]);
export const MediaUrlSchema = z.url().max(4096).refine(value => {
  const u = new URL(value), h = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
    h.includes(".") && !h.endsWith(".local") && !h.endsWith(".localhost") &&
    !/^([0-9.]+|\[.*\])$/.test(h);
}, "Use a public HTTPS media URL without credentials.");
export const AssetSchema = z.object({
  kind: z.enum(["image", "video"]), url: MediaUrlSchema,
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
});
export const MediaOutputSchema = z.strictObject({ assets: z.array(AssetSchema).min(1).max(100), credits: z.number().int().nonnegative().max(2_147_483_647) });
export const GuidanceOutputSchema = z.strictObject({ assets: z.array(AssetSchema).max(0), credits: z.literal(0), text: SkillTextSchema, skill: SkillReceiptSchema });
export const ToolOutputSchema = z.union([MediaOutputSchema, GuidanceOutputSchema, PlanOutputSchema]);
export const ToolInvocationSchema = z.object({
  id: z.uuid(), runId: z.uuid(), callId: z.string().min(1).max(200),
  name: ToolNameSchema, label: z.string().max(80), position: z.number().int().nonnegative(),
  approval: ApprovalSchema.nullable().optional(),
  status: ToolStatusSchema, input: z.record(z.string(), z.json()),
  providerRunId: z.string().max(200).nullable(), output: ToolOutputSchema.nullable(),
  credits: z.number().int().nonnegative(), error: z.string().max(300).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
});
export const MediaTaskPayloadSchema = z.strictObject({ invocationId: z.uuid() });
export const ToolResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), invocationId: z.uuid(), output: ToolOutputSchema }),
  z.strictObject({ ok: z.literal(false), invocationId: z.uuid().optional(), error: z.string().max(300), retryable: z.boolean(), code: z.enum(["INVALID_INPUT", "PLAN_DECLINED"]).optional() }),
]);
export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export const formatCredits = (credits: number) => `${Number((credits / 1_000_000).toFixed(6))}M credits`;

export const COMPOSER_USAGE_LABEL = "OpenRouter Free · Text: 0M credits · Media tools billed separately";
