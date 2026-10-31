import { expect, it } from "vitest";
import { TurnContent } from "../src/agent/turn-content";
import { MAX_CONTENT_BLOCKS, MAX_REASONING_LENGTH } from "../src/contracts/content";
import { MessageContentSchema } from "../src/contracts/chats";
import { WebhookUrlSchema } from "../src/contracts/webhooks";
import { MediaUrlSchema, MediaOutputSchema } from "../src/contracts/tools";

it("validates ordered thinking, reasoning, citations and zero-credit model usage alongside legacy blocks", () => {
  const blocks = [
    { type: "thinking", startedAt: "2026-10-31T00:00:00.000Z", durationMs: 1200 },
    { type: "reasoning", text: "Checked the supplied evidence.", format: "summary" },
    { type: "text", text: "Answer" },
    { type: "citation", url: "https://example.com/source", title: "Source", startIndex: 0, endIndex: 6 },
    { type: "usage", actualModel: "fixture/free", promptTokens: 4, completionTokens: 8, applicationCredits: 0 },
  ];
  expect(MessageContentSchema.parse(blocks)).toEqual(blocks);
  expect(MessageContentSchema.parse([{ type: "text", text: "Legacy" }])).toHaveLength(1);
});
it("rejects executable citation URLs, reversed offsets and nonzero LLM credits", () => {
  for (const block of [
    { type: "citation", url: "javascript:alert(1)", title: "Unsafe" },
    { type: "citation", url: "not a URL", title: "Malformed" },
    { type: "citation", url: "https://example.com", title: "Invalid", startIndex: 10, endIndex: 1 },
    { type: "usage", actualModel: "fixture/free", promptTokens: 4, completionTokens: 8, applicationCredits: 1 },
  ]) expect(MessageContentSchema.safeParse([block]).success).toBe(false);
});
it("accepts a generated audio asset through the same validated output contract", () => {
  const result = { assets: [{ kind: "audio", url: "https://example.com/result.wav" }], credits: 0 };
  expect(MediaOutputSchema.parse(result)).toEqual(result);
});

it("keeps a valid, bounded partial transcript when reasoning or block limits are reached", () => {
  const turn = new TurnContent(); turn.beginThinking(); turn.appendReasoning("x".repeat(MAX_REASONING_LENGTH), "text");
  expect(() => turn.appendReasoning("overflow", "summary")).toThrow("reasoning limit");
  turn.appendText("Saved answer");
  while (turn.blocks.length < MAX_CONTENT_BLOCKS) turn.appendCitation({ type: "citation", url: "https://example.com", title: "Source" });
  expect(() => turn.appendUsage({ actualModel: "fixture/free", promptTokens: 1, completionTokens: 1 })).toThrow("content limit");
  turn.endThinking();
  expect(turn.text).toBe("Saved answer"); expect(MessageContentSchema.parse(turn.blocks)).toHaveLength(MAX_CONTENT_BLOCKS);
  expect(turn.blocks[0]).toMatchObject({ durationMs: expect.any(Number) });
});

it("returns validation errors rather than throwing internal errors for malformed external URLs", () => {
  for (const url of ["not a URL", "https://", "https://[invalid]"]) {
    expect(MediaUrlSchema.safeParse(url).success).toBe(false);
    expect(WebhookUrlSchema.safeParse(url).success).toBe(false);
    expect(MediaOutputSchema.safeParse({ assets: [{ kind: "audio", url }], credits: 0 }).success).toBe(false);
  }
});
