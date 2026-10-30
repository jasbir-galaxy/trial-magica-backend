import { z } from "zod";
import { createParser } from "eventsource-parser";
import { readOpenRouterEnvironment } from "../config/agent";
import { MAX_TOOL_CALLS, MAX_TOOL_INPUT_BYTES } from "../contracts/tools";
import { MAX_TEXT_LENGTH } from "../contracts/chats";
import { ModelError, type ModelEvent, type TextModel } from "./model";

const ChunkSchema = z.object({
  model: z.string().min(1).max(200).optional(), error: z.unknown().optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.object({ index: z.number().int().min(0).max(MAX_TOOL_CALLS - 1), id: z.string().max(200).optional(), type: z.literal("function").optional(), function: z.object({ name: z.string().max(100).optional(), arguments: z.string().max(MAX_TOOL_INPUT_BYTES).optional() }).optional() })).optional() }).optional(), finish_reason: z.string().nullable().optional() })).optional(),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullish(),
});
const invalid = () => new ModelError("INVALID_STREAM", "The reply was interrupted before it finished. Please try again.");
const unavailable = () => new ModelError("UNAVAILABLE", "Free models are temporarily unavailable. Please try again shortly.");
export function createOpenRouterModel(fetcher: typeof fetch = fetch): TextModel {
  return { async *stream(messages, signal, tools = []) {
    const env = readOpenRouterEnvironment();
    const timeout = AbortSignal.timeout(90_000);
    const combined = AbortSignal.any([signal, timeout]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let actualModel = "";
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
    try {
      combined.throwIfAborted();
      const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENROUTER_MODEL, messages: messages.map(message => {
          if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
          if (message.role === "assistant" && message.toolCalls?.length) return { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) };
          return message;
        }), ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: t })), tool_choice: "auto", parallel_tool_calls: true } : {}), stream: true, stream_options: { include_usage: true }, max_tokens: 4096 }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw new ModelError("RATE_LIMITED", "Free models are busy. Please wait a moment and try again.");
        if (response.status === 401 || response.status === 403) throw new ModelError("AUTHENTICATION", "The chat service could not connect. Please contact support.");
        throw unavailable();
      }
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw invalid();
      reader = response.body.getReader();
      const frames: string[] = [];
      const parser = createParser({ maxBufferSize: 256_000, onEvent: event => frames.push(event.data), onError: () => { throw invalid(); } });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let done = false, finish: string | null = null, text = "";
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        for (const data of frames.splice(0)) {
          if (done) throw invalid();
          if (data === "[DONE]") { done = true; continue; }
          let value: z.infer<typeof ChunkSchema>;
          try { value = ChunkSchema.parse(JSON.parse(data)); } catch { throw invalid(); }
          if (value.error !== undefined) throw unavailable();
          if (value.model) actualModel = value.model;
          if (value.usage) usage = value.usage;
          for (const choice of value.choices ?? []) {
            for (const delta of choice.delta?.tool_calls ?? []) {
              const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
              if (delta.id) { if (call.id && call.id !== delta.id) throw invalid(); call.id = delta.id; }
              call.name += delta.function?.name ?? ""; call.arguments += delta.function?.arguments ?? "";
              if (call.name.length > 100 || Buffer.byteLength(call.arguments) > MAX_TOOL_INPUT_BYTES) throw invalid();
              calls.set(delta.index, call);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
            const delta = choice.delta?.content;
            if (delta) {
              if (text.length + delta.length > MAX_TEXT_LENGTH) throw new ModelError("LIMIT", "This reply reached the length limit. Ask a shorter follow-up to continue.");
              text += delta;
              yield { type: "text", text: delta } satisfies ModelEvent;
            }
          }
        }
      }
      if (!done || !actualModel) throw invalid();
      if (calls.size) {
        const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        if (finish !== "tool_calls" || new Set(ordered.map(c => c.id)).size !== ordered.length || ordered.some(c => !c.id || !c.name || !c.arguments)) throw invalid();
        yield { type: "tool_calls", calls: ordered };
      } else if (finish !== "stop" || !text.trim()) throw invalid();
      yield { type: "usage", usage: { actualModel, promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null } } satisfies ModelEvent;
    } catch (error) {
      // Preserve any accounting already received even when the final frame fails.
      if (actualModel) yield { type: "usage", usage: { actualModel, promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null } };
      if (signal.aborted) throw new ModelError("CANCELLED", "This reply was stopped.");
      if (timeout.aborted) throw new ModelError("TIMEOUT", "This reply took too long. Please try again.");
      if (error instanceof ModelError) throw error;
      throw unavailable();
    } finally {
      if (reader) { try { await reader.cancel(); } catch { /* Connection is already closed. */ } reader.releaseLock(); }
    }
  } };
}
