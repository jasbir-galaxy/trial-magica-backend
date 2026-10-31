import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runToolLoop } from "../src/agent/tool-loop";
import { registryFromCatalog } from "../src/tools/registry";
import type { TextModel, ModelMessage } from "../src/agent/model";
import catalog from "./fixtures/magica-catalog.json";
const registry = registryFromCatalog(catalog);
const success = () => ({ ok: true as const, invocationId: randomUUID(), output: { assets: [{ kind: "image" as const, url: "https://example.com/generated.png" }], credits: 100 } });
it("passes typed definitions every step and chains a generated URL into crop in deterministic order", async () => {
  let turn = 0; const captured: ModelMessage[][] = [];
  const model: TextModel = { async *stream(messages, _signal, tools) {
    captured.push(structuredClone(messages)); expect(tools?.map(t => t.name)).toEqual([...registry.keys()]);
    turn++;
    if (turn === 1) yield { type: "tool_calls", calls: [{ id: "generate", name: "gpt_image_2", arguments: JSON.stringify({ subModelId: "gpt-image-2-text", input: { prompt: "A circle" } }) }] };
    else if (turn === 2) {
      const result = messages.at(-1)!; expect(result.role).toBe("tool");
      const url = JSON.parse(result.content).output.assets[0].url;
      yield { type: "tool_calls", calls: [{ id: "crop", name: "crop_image", arguments: JSON.stringify({ image_url: url, crop: { x: 0, y: 0, width: 64, height: 64 } }) }] };
    } else yield { type: "text", text: "Here is your cropped image." };
  } };
  const hooks = { text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([success()]) };
  await runToolLoop(model, [{ role: "user", content: "Generate and crop" }], registry, new AbortController().signal, hooks);
  expect(hooks.tools).toHaveBeenCalledTimes(2);
  expect(JSON.parse(hooks.tools.mock.calls[1][0][0].arguments).image_url).toBe("https://example.com/generated.png");
  expect(captured[2].map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  expect(hooks.text).toHaveBeenCalledWith("Here is your cropped image.");
});
it("does not let the model automatically repeat failed or ambiguous media work", async () => {
  const stream = vi.fn(async function* () { yield { type: "tool_calls" as const, calls: [{ id: "call", name: "crop_image", arguments: "{}" }] }; });
  const hooks = { text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([{ ok: false, error: "Receipt unknown", retryable: false }]) };
  await expect(runToolLoop({ stream }, [], registry, new AbortController().signal, hooks)).rejects.toThrow("Receipt unknown");
  expect(stream).toHaveBeenCalledTimes(1);
});
it("bounds repeated tool turns and prevents dispatch after cancellation", async () => {
  let id = 0;
  const model: TextModel = { async *stream() { yield { type: "tool_calls", calls: [{ id: String(id++), name: "crop_image", arguments: "{}" }] }; } };
  const hooks = { text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([success()]) };
  await expect(runToolLoop(model, [], registry, new AbortController().signal, hooks)).rejects.toThrow("step limit");
  expect(hooks.tools).toHaveBeenCalledTimes(6);
  const controller = new AbortController(); controller.abort(); hooks.tools.mockClear();
  await expect(runToolLoop(model, [], registry, controller.signal, hooks)).rejects.toThrow();
  expect(hooks.tools).not.toHaveBeenCalled();
});

it("lets the model correct invalid inputs before any media job is submitted", async () => {
  let turn = 0;
  const model: TextModel = { async *stream(messages) {
    turn++;
    if (turn === 1) yield { type: "tool_calls", calls: [{ id: "invalid", name: "crop_image", arguments: '{"image_url":"https://example.com/source.png"}' }] };
    else if (turn === 2) {
      expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ code: "INVALID_INPUT" });
      yield { type: "tool_calls", calls: [{ id: "fixed", name: "crop_image", arguments: '{"image_url":"https://example.com/source.png","crop":{"x":0,"y":0,"width":64,"height":64}}' }] };
    } else yield { type: "text", text: "Here is the crop." };
  } };
  const hooks = { text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValueOnce([{ ok: false, code: "INVALID_INPUT", error: "Provide a complete crop rectangle.", retryable: true }]).mockResolvedValueOnce([success()]) };
  await runToolLoop(model, [], registry, new AbortController().signal, hooks);
  expect(hooks.tools).toHaveBeenCalledTimes(2); expect(hooks.text).toHaveBeenCalledWith("Here is the crop.");
});
it("bounds input corrections and never treats an executed tool as an input-only retry", async () => {
  const stream = vi.fn(async function* () { yield { type: "tool_calls" as const, calls: [{ id: "call", name: "crop_image", arguments: "{}" }] }; });
  const invalid = { ok: false, code: "INVALID_INPUT", error: "Provide a complete crop rectangle.", retryable: true };
  const hooks = { text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([invalid]) };
  await expect(runToolLoop({ stream }, [], registry, new AbortController().signal, hooks)).rejects.toThrow("No tools were started for this step");
  expect(hooks.tools).toHaveBeenCalledTimes(3);
  hooks.tools.mockClear().mockResolvedValue([{ ...invalid, invocationId: randomUUID() }]); stream.mockClear();
  await expect(runToolLoop({ stream }, [], registry, new AbortController().signal, hooks)).rejects.toThrow("complete crop rectangle");
  expect(hooks.tools).toHaveBeenCalledTimes(1);
});

it("gives the model display-ready M credits without exposing raw billing units", async () => {
  let step = 0;
  const output = { assets: [{ kind: "video" as const, url: "https://example.com/merged.mp4" }], credits: 12675 };
  const model: TextModel = { async *stream(messages) {
    if (step++ === 0) yield { type: "tool_calls", calls: [{ id: "merge", name: "merge_videos", arguments: "{}" }] };
    else {
      const result = JSON.parse(messages.at(-1)!.content);
      expect(result.output.creditUsage).toBe("0.012675M credits");
      expect(result.output).not.toHaveProperty("credits");
      yield { type: "text", text: result.output.creditUsage };
    }
  } };
  await runToolLoop(model, [], registry, new AbortController().signal, {
    text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([{ ok: true, invocationId: randomUUID(), output }]),
  });
  expect(output.credits).toBe(12675);
});

it("keeps schema correction details out of the terminal user-facing error", async () => {
  const model: TextModel = { async *stream() { yield { type: "tool_calls", calls: [{ id: "invalid", name: "gpt_image_2", arguments: "{}" }] }; } };
  const error = await runToolLoop(model, [], registry, new AbortController().signal, {
    text: vi.fn(), usage: vi.fn(), tools: vi.fn().mockResolvedValue([{ ok: false, code: "INVALID_INPUT", error: "GPT Image 2 inputs need correction: input (invalid_type). Follow the tool schema.", retryable: true }]),
  }).catch((failure: Error) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toMatch(/schema|invalid_type/);
});
