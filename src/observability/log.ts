import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9_:.-]{1,200}$/);
const Fields = z.object({
  traceId: z.uuid().optional(), requestTraceId: z.uuid().optional(),
  chatId: z.uuid().optional(), runId: z.uuid().optional(), messageId: z.uuid().optional(),
  processId: identifier.optional(), triggerRunId: identifier.optional(),
  invocationId: z.uuid().optional(), waitpointId: z.uuid().optional(), waitpointTokenId: identifier.optional(),
  providerRunId: identifier.optional(), uploadId: z.uuid().optional(),
  status: z.union([z.number().int(), identifier]).optional(), code: identifier.optional(),
  reason: identifier.optional(), stage: identifier.optional(), upstreamStatus: z.number().int().optional(),
  verificationReason: identifier.optional(), errorKind: identifier.optional(),
  fields: z.array(z.string().max(120)).max(20).optional(),
});
export type LogFields = z.infer<typeof Fields>;
const storage = new AsyncLocalStorage<LogFields>();
export function withLogContext<T>(fields: LogFields, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, work);
}
export function runLogContext(run: { id: string; chatId: string; assistantMessageId: string; triggerRunId?: string | null }): LogFields {
  // The server-generated run UUID is the durable trace across dispatch retries,
  // restarts and recovery. requestTraceId links the accepting HTTP request to it.
  return { traceId: run.id, runId: run.id, chatId: run.chatId, messageId: run.assistantMessageId,
    ...(run.triggerRunId ? { triggerRunId: run.triggerRunId } : {}) };
}
export function logEvent(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  const merged = { processId: String(process.pid), ...storage.getStore(), ...fields };
  // An explicit allowlist prevents headers, raw errors, inputs, outputs and
  // credentials from entering the logging sink. Invalid diagnostics cannot fail work.
  const safe: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(Fields.shape)) {
    const parsed = schema.safeParse(merged[key as keyof LogFields]);
    if (parsed.success && parsed.data !== undefined) safe[key] = parsed.data;
  }
  console[level](event, safe);
}
