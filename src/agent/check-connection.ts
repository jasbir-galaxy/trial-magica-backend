import { z } from "zod";
import { FREE_MODEL, readOpenRouterEnvironment } from "../config/agent";

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHECK_TIMEOUT_MS = 30_000;
// Free routing can select a reasoning model. Its reasoning shares this
// completion budget; 32 tokens produced finish_reason=length in the live probe.
const CHECK_MAX_TOKENS = 1_024;

const CompletionSchema = z.object({
  model: z.string().min(1).max(200),
  choices: z.array(z.object({
    message: z.object({ content: z.string().trim().min(1) }),
    finish_reason: z.literal("stop"),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).optional(),
});

export const ConnectionCheckResultSchema = z.object({
  requestedModel: z.literal(FREE_MODEL),
  actualModel: z.string().min(1).max(200),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
});

export class ConnectionCheckError extends Error {
  constructor(readonly code: "AUTHENTICATION" | "RATE_LIMITED" | "UNAVAILABLE" | "INVALID_RESPONSE" | "CANCELLED" | "TIMEOUT") {
    const messages = {
      AUTHENTICATION: "The model connection was rejected. Check the backend API key.",
      RATE_LIMITED: "The free model service is busy. Try the check again later.",
      UNAVAILABLE: "The free model service is unavailable. Try the check again later.",
      INVALID_RESPONSE: "The free model service did not return a complete text response.",
      CANCELLED: "The connection check was cancelled.",
      TIMEOUT: "The free model connection check timed out. Try again later.",
    };
    super(messages[code]);
    this.name = "ConnectionCheckError";
  }
}

/** An operator-only probe; no chat history, attachments, or secrets in its output. */
export async function checkOpenRouterConnection(options: {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
} = {}) {
  const env = readOpenRouterEnvironment(options.env);
  const signal = AbortSignal.any([
    AbortSignal.timeout(CHECK_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(COMPLETIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      // Fixed request construction: no model arrays, paid fallbacks, plugins, or BYOK.
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: [{ role: "user", content: "Reply with the single word ready." }],
        max_tokens: CHECK_MAX_TOKENS,
        stream: false,
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      // Provider response bodies can include raw request details. Never log them.
      await response.body?.cancel();
      throw new ConnectionCheckError(response.status === 401 || response.status === 403
        ? "AUTHENTICATION" : response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE");
    }
    const parsed = CompletionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ConnectionCheckError("INVALID_RESPONSE");
    return ConnectionCheckResultSchema.parse({
      requestedModel: FREE_MODEL,
      actualModel: parsed.data.model,
      promptTokens: parsed.data.usage?.prompt_tokens ?? null,
      completionTokens: parsed.data.usage?.completion_tokens ?? null,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ConnectionCheckError("CANCELLED");
    if (signal.aborted) throw new ConnectionCheckError("TIMEOUT");
    if (error instanceof ConnectionCheckError) throw error;
    throw new ConnectionCheckError("UNAVAILABLE");
  }
}
