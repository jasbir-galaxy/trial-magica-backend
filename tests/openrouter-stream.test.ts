import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenRouterModel } from "../src/agent/openrouter";
import type { ModelEvent } from "../src/agent/model";
const chunk = (text: string, finish: string | null = null) => JSON.stringify({ model: "fixture/free-model", choices: [{ delta: { content: text }, finish_reason: finish }] });
function response(events: string[], split = false) {
  const wire = ": keepalive\r\n\r\n" + events.map(data => `data: ${data}\r\n\r\n`).join("");
  const encoded = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(encoded);
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function collect(fetcher: typeof fetch, signal = new AbortController().signal) {
  const events: ModelEvent[] = [];
  for await (const event of createOpenRouterModel(fetcher).stream([{ role: "user", content: "Hello" }], signal)) events.push(event);
  return events;
}
beforeEach(() => { vi.stubEnv("OPENROUTER_API_KEY", "private-test-value"); vi.stubEnv("OPENROUTER_MODEL", "openrouter/free"); });
afterEach(() => vi.unstubAllEnvs());
it("parses fragmented UTF-8, comments, repeated terminal frames and usage; sends only the free route", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([chunk("Héllo 🌍"), chunk("", "stop"), JSON.stringify({ model: "fixture/free-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }), "[DONE]"], true));
  const events = await collect(fetcher);
  expect(events).toEqual([{ type: "text", text: "Héllo 🌍" }, { type: "usage", usage: { actualModel: "fixture/free-model", promptTokens: 20, completionTokens: 30 } }]);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ model: "openrouter/free", stream: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 429, 503])("fails safely without retry or paid fallback on %s", async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-body", { status }));
  await expect(collect(fetcher)).rejects.not.toThrow("private-provider-body");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  [chunk("", "stop"), "[DONE]"], [chunk("partial", "length"), "[DONE]"], [chunk("partial", "stop")], ["not-json", "[DONE]"],
  [chunk("partial"), JSON.stringify({ error: { message: "secret provider exception" } }), "[DONE]"],
].map(events => ({ events })))("rejects empty, truncated, disconnected, malformed and error streams", async ({ events }) => {
  await expect(collect(vi.fn<typeof fetch>().mockResolvedValue(response(events)))).rejects.toThrow();
});
it("retains already emitted text before a stream failure", async () => {
  const received: string[] = [];
  const model = createOpenRouterModel(vi.fn<typeof fetch>().mockResolvedValue(response([chunk("Saved partial"), chunk("", "length"), "[DONE]"])));
  await expect((async () => { for await (const event of model.stream([], new AbortController().signal)) if (event.type === "text") received.push(event.text); })()).rejects.toThrow();
  expect(received).toEqual(["Saved partial"]);
});
it("does not start an already cancelled request", async () => {
  const fetcher = vi.fn<typeof fetch>(); const controller = new AbortController(); controller.abort();
  await expect(collect(fetcher, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps known routing and usage when a final stream frame fails", async () => {
  const accounting: ModelEvent[] = [];
  const model = createOpenRouterModel(vi.fn<typeof fetch>().mockResolvedValue(response([chunk("Partial"), JSON.stringify({ model: "fixture/free-model", usage: { prompt_tokens: 7, completion_tokens: 2 }, choices: [{ delta: {}, finish_reason: "length" }] }), "[DONE]"])));
  await expect((async () => { for await (const event of model.stream([], new AbortController().signal)) if (event.type === "usage") accounting.push(event); })()).rejects.toThrow();
  expect(accounting).toEqual([{ type: "usage", usage: { actualModel: "fixture/free-model", promptTokens: 7, completionTokens: 2 } }]);
});


it("assembles fragmented parallel function arguments before exposing calls", async () => {
  const event = (tool_calls: unknown[], finish_reason: string | null = null) => JSON.stringify({ model: "fixture/free-model", choices: [{ delta: { tool_calls }, finish_reason }] });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
    event([{ index: 1, id: "second", type: "function", function: { name: "crop_image", arguments: '{"image_url":' } }, { index: 0, id: "first", function: { name: "gpt_image_2", arguments: '{"input":' } }]),
    event([{ index: 0, function: { arguments: '{"prompt":"Circle"}}' } }, { index: 1, function: { arguments: '"https://example.com/a.png"}' } }]),
    event([], "tool_calls"), "[DONE]",
  ], true));
  const events = await collect(fetcher);
  expect(events[0]).toEqual({ type: "tool_calls", calls: [
    { id: "first", name: "gpt_image_2", arguments: '{"input":{"prompt":"Circle"}}' },
    { id: "second", name: "crop_image", arguments: '{"image_url":"https://example.com/a.png"}' },
  ] });
});
it("serializes tool result IDs and includes tool contracts on follow-up requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([chunk("Done", "stop"), "[DONE]"]));
  const model = createOpenRouterModel(fetcher);
  for await (const event of model.stream([
    { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "crop_image", arguments: "{}" }] },
    { role: "tool", toolCallId: "call1", content: '{"ok":true}' },
  ], new AbortController().signal, [{ name: "crop_image", description: "Crop", parameters: { type: "object" } }])) void event;
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body.messages[0].tool_calls[0].id).toBe("call1"); expect(body.messages[1].tool_call_id).toBe("call1");
  expect(body.tools[0].function.name).toBe("crop_image"); expect(body.model).toBe("openrouter/free");
});
it("does not expose tool calls from truncated or oversized argument streams", async () => {
  for (const argumentsText of ["{}", "x".repeat(48001)]) {
    const events: ModelEvent[] = [];
    const data = JSON.stringify({ model: "fixture/free", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "crop_image", arguments: argumentsText } }] }, finish_reason: "length" }] });
    const model = createOpenRouterModel(vi.fn<typeof fetch>().mockResolvedValue(response([data, "[DONE]"])));
    await expect((async () => { for await (const e of model.stream([], new AbortController().signal)) events.push(e); })()).rejects.toThrow();
    expect(events.some(e => e.type === "tool_calls")).toBe(false);
  }
});

it("streams provider-visible reasoning and safe citations without exposing encrypted details or paid plugins", async () => {
  const annotation = { type: "url_citation", url_citation: { url: "https://example.com/source", title: "Source", start_index: 0, end_index: 6 } };
  const event = (delta: unknown) => JSON.stringify({ model: "fixture/free", choices: [{ delta }] });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
    event({ reasoning: "duplicate legacy field", reasoning_details: [{ type: "reasoning.summary", summary: "Checking the supplied facts." }, { type: "reasoning.encrypted", data: "opaque-private-data" }] }),
    event({ content: "Answer", annotations: [annotation, { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "Unsafe" } }] }),
    event({ annotations: [annotation] }), chunk("", "stop"), "[DONE]",
  ], true));
  const events = await collect(fetcher);
  expect(events.filter(e => e.type !== "usage")).toEqual([
    { type: "reasoning", text: "Checking the supplied facts.", format: "summary" },
    { type: "text", text: "Answer" },
    { type: "citation", citation: { type: "citation", url: "https://example.com/source", title: "Source", startIndex: 0, endIndex: 6 } },
  ]);
  expect(JSON.stringify(events)).not.toContain("opaque-private-data");
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).not.toHaveProperty("plugins");
});

it("accepts plaintext reasoning deltas and bounds accumulated reasoning independently of visible answer text", async () => {
  const event = (reasoning: string) => JSON.stringify({ model: "fixture/free", choices: [{ delta: { reasoning } }] });
  const events = await collect(vi.fn<typeof fetch>().mockResolvedValue(response([event("Checking "), event("details."), chunk("Answer", "stop"), "[DONE]"])));
  expect(events.slice(0, 2)).toEqual([{ type: "reasoning", text: "Checking ", format: "text" }, { type: "reasoning", text: "details.", format: "text" }]);
  await expect(collect(vi.fn<typeof fetch>().mockResolvedValue(response([event("a".repeat(16001)), event("b".repeat(16000)), chunk("Answer", "stop"), "[DONE]"])))).rejects.toThrow();
});
