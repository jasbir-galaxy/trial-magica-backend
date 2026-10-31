import { ContentBlockSchema, MAX_CONTENT_BLOCKS, MAX_REASONING_LENGTH, MAX_TEXT_LENGTH, type ContentBlock, type CitationBlock, type ReasoningFormat } from "../contracts/content";
import { ModelError, type ModelUsage } from "./model";

/** One ordered, bounded transcript shared by durable readback and text frames. */
export class TurnContent {
  readonly blocks: ContentBlock[] = [];
  text = "";
  private reasoningLength = 0;
  private thinking?: Extract<ContentBlock, { type: "thinking" }>;
  private append(block: ContentBlock) {
    if (this.blocks.length >= MAX_CONTENT_BLOCKS) throw new ModelError("LIMIT", "This reply reached its content limit. Your completed work is saved.");
    this.blocks.push(ContentBlockSchema.parse(block));
  }
  beginThinking() {
    this.endThinking();
    this.append({ type: "thinking", startedAt: new Date().toISOString(), durationMs: null });
    this.thinking = this.blocks.at(-1) as Extract<ContentBlock, { type: "thinking" }>;
  }
  endThinking() {
    if (this.thinking) this.thinking.durationMs = Math.max(0, Date.now() - Date.parse(this.thinking.startedAt));
    this.thinking = undefined;
  }
  appendText(delta: string) {
    if (!delta) return;
    if (this.text.length + delta.length > MAX_TEXT_LENGTH) throw new ModelError("LIMIT", "This reply reached the length limit. Your completed tools are saved.");
    this.endThinking();
    const last = this.blocks.at(-1);
    if (last?.type === "text") last.text += delta;
    else this.append({ type: "text", text: delta });
    this.text += delta;
  }
  appendReasoning(text: string, format: ReasoningFormat) {
    if (!text) return;
    if (this.reasoningLength + text.length > MAX_REASONING_LENGTH) throw new ModelError("LIMIT", "This reply reached its reasoning limit. Your completed work is saved.");
    const last = this.blocks.at(-1);
    if (last?.type === "reasoning" && last.format === format) last.text += text;
    else this.append({ type: "reasoning", text, format });
    this.reasoningLength += text.length;
  }
  appendCitation(citation: CitationBlock) { this.append(citation); }
  appendUsage(usage: ModelUsage) { this.endThinking(); this.append({ type: "usage", ...usage, applicationCredits: 0 }); }
  appendTool(invocationId: string) {
    this.endThinking();
    if (!this.blocks.some(block => block.type === "tool" && block.invocationId === invocationId)) this.append({ type: "tool", invocationId });
  }
}
