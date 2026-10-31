import type { CitationBlock, ReasoningFormat } from "../contracts/content";

export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelToolCall = { id: string; name: string; arguments: string };
export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
export type ModelUsage = { actualModel: string; promptTokens: number | null; completionTokens: number | null };
export type ModelEvent = { type: "text"; text: string } | { type: "usage"; usage: ModelUsage } | { type: "tool_calls"; calls: ModelToolCall[] } | { type: "reasoning"; text: string; format: ReasoningFormat } | { type: "citation"; citation: CitationBlock };
export interface TextModel { stream(messages: ModelMessage[], signal: AbortSignal, tools?: ModelTool[]): AsyncIterable<ModelEvent> }
export class ModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ModelError"; }
}
