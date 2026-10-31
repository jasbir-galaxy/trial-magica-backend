import { modelToolOutput } from "./tool-output";
import { MAX_AGENT_STEPS, MAX_TOOL_CALLS, MAX_INPUT_CORRECTIONS, ToolResultSchema, type ToolResult } from "../contracts/tools";
import { ModelError, type ModelMessage, type ModelToolCall, type TextModel, type ModelUsage } from "./model";
import { modelTools, type ToolRegistry } from "../tools/registry";

import type { CitationBlock, ReasoningFormat } from "../contracts/content";

export type LoopHooks = {
  step?(): void | Promise<void>;
  reasoning?(text: string, format: ReasoningFormat): void | Promise<void>;
  citation?(value: CitationBlock): void | Promise<void>;
  text(delta: string): Promise<void>;
  usage(value: ModelUsage): void | Promise<void>;
  tools(calls: ModelToolCall[]): Promise<ToolResult[]>;
};
export async function runToolLoop(model: TextModel, messages: ModelMessage[], registry: ToolRegistry, signal: AbortSignal, hooks: LoopHooks) {
  let count = 0, corrections = 0;
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    signal.throwIfAborted();
    await hooks.step?.();
    let text = "", calls: ModelToolCall[] = [];
    for await (const event of model.stream(messages, signal, modelTools(registry))) {
      if (event.type === "usage") await hooks.usage(event.usage);
      else if (event.type === "text") { text += event.text; await hooks.text(event.text); }
      else if (event.type === "reasoning") await hooks.reasoning?.(event.text, event.format);
      else if (event.type === "citation") await hooks.citation?.(event.citation);
      else { if (calls.length) throw new ModelError("INVALID_TOOLS", "The tool response was invalid. Please try again."); calls = event.calls; }
    }
    if (!calls.length) return;
    count += calls.length;
    if (count > MAX_TOOL_CALLS) throw new ModelError("TOOL_LIMIT", "This reply reached its tool limit. Send a follow-up to continue.");
    signal.throwIfAborted();
    const results = await hooks.tools(calls);
    if (results.length !== calls.length) throw new Error("Tool result count mismatch");
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    for (let i = 0; i < calls.length; i++) {
      const result = ToolResultSchema.parse(results[i]);
      messages.push({ role: "tool", toolCallId: calls[i].id, content: JSON.stringify(result.ok ? { ...result, output: modelToolOutput(result.output) } : result) });
    }
    // Unresolved or failed work remains visible and retryable; never let a model
    // hide the failure with a success-sounding final message or a blind repost.
    const failure = results.find(r => !r.ok);
    if (failure && !failure.ok) {
      // Correction is allowed only when the entire batch was rejected before
      // admission. Provider failures/unknown receipts must never be replayed.
      const inputOnly = results.every(r => !r.ok && r.code === "INVALID_INPUT" && !r.invocationId);
      if (inputOnly && corrections++ < MAX_INPUT_CORRECTIONS) continue;
      // Schema details help the model repair arguments, but are not useful UI copy.
      if (inputOnly) throw new ModelError("INVALID_INPUT", "The media settings could not be prepared. No tools were started for this step. Try again with the source files and desired settings; any earlier results are saved.");
      throw new ModelError(failure.code ?? "TOOL_FAILED", failure.error);
    }
  }
  throw new ModelError("TURN_LIMIT", "This reply reached its step limit. Your completed tools are saved. Send a follow-up to continue.");
}
