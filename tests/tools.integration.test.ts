import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat, listMessages } from "../src/chats/service";
import { contextForRun, createTurn, finishRun, getOwnedRun, saveProgress, stopRun } from "../src/agent/run-store";
import { executeTurn } from "../src/agent/execute-turn";
import { registerInvocation, settleInvocation, toolResult } from "../src/tools/store";
import { decideApproval, type ApprovalDriver } from "../src/approvals/store";
import { executeMediaTool as executeApprovedMediaTool } from "../src/tools/execute";
import { registryFromCatalog, prepareTool } from "../src/tools/registry";
import { ToolServiceError, type MagicaClient, type ProviderRun } from "../src/tools/magica-client";
import { ModelError, type TextModel } from "../src/agent/model";
import catalog from "./fixtures/magica-catalog.json";
vi.mock("../src/tools/image-metadata", () => ({ enrichImageMetadata: vi.fn(async (output: unknown) => output) }));
vi.mock("server-only", () => ({}));
const db = getDatabase(), user = `tools_test_${randomUUID()}`;
const registry = registryFromCatalog(catalog);
const image = "https://example.com/source.png";
const crop = prepareTool(registry, "crop_image", { image_url: image, crop: { x: 0, y: 0, width: 64, height: 64 } });
const idleWait = vi.fn(async () => {});
const signal = () => new AbortController().signal;
const approvals: ApprovalDriver = {
  async create(id) { const row = await db.waitpoint.findUniqueOrThrow({ where: { id } }); await decideApproval(user, id, { requestId: randomUUID(), inputHash: row.inputHash, decision: "approved" }); return `token_${id}`; },
  async wait() {}, async complete() {},
};
const executeMediaTool: typeof executeApprovedMediaTool = (id, worker, wait, signal, client) => executeApprovedMediaTool(id, worker, wait, signal, client, approvals);

async function fixture(running = true) {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "1000000");
  const { chat } = await createChat(user, { title: "Tool integration fixture" });
  const run = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Crop this image", model: "openrouter/free" });
  if (running) await db.agentRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });
  return { chat, run };
}
function provider(receipt: string = randomUUID()): MagicaClient {
  return { catalog: vi.fn(), estimate: vi.fn().mockResolvedValue(5000), start: vi.fn().mockResolvedValue({ runId: receipt }), read: vi.fn().mockResolvedValue({ id: receipt, nodeType: "crop_image", status: "COMPLETED", creditUsed: 5000, output: { image_url: "https://example.com/cropped.png" } } satisfies ProviderRun) };
}
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.waitpoint.deleteMany({ where: { tool: { run: { chat: { user: { clerkUserId: user } } } } } });
  await db.toolInvocation.deleteMany({ where: { run: { chat: { user: { clerkUserId: user } } } } });
  await db.agentRun.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.user.deleteMany({ where: { clerkUserId: user } });
  idleWait.mockClear();
});
afterAll(async () => db.$disconnect());
it("deduplicates concurrent registration, submits once, saves the receipt before polling, and settles once", async () => {
  const { run } = await fixture();
  const rows = await Promise.all(Array.from({ length: 4 }, () => registerInvocation(run.id, "same-call", crop)));
  expect(new Set(rows.map(r => r.id)).size).toBe(1);
  const client = provider(); const originalRead = client.read;
  client.read = vi.fn(async id => { expect((await db.toolInvocation.findUniqueOrThrow({ where: { id: rows[0].id } })).providerRunId).toBe(id); return originalRead(id); });
  await Promise.all([executeMediaTool(rows[0].id, "worker1", idleWait, signal(), client), executeMediaTool(rows[0].id, "worker2", idleWait, signal(), client)]);
  const replay = await executeMediaTool(rows[0].id, "worker3", idleWait, signal(), client);
  expect(replay.ok).toBe(true);
  const newCall = await registerInvocation(run.id, "another-model-call-same-input", crop);
  expect(newCall.id).toBe(rows[0].id);
  await executeMediaTool(newCall.id, "worker4", idleWait, signal(), client);
  expect(client.start).toHaveBeenCalledTimes(1);
  expect((await getOwnedRun(user, run.id)).applicationCredits).toBe(5000);
  expect(await db.toolInvocation.count({ where: { runId: run.id } })).toBe(1);
  await expect(registerInvocation(run.id, "same-call", { ...crop, inputHash: "different" })).rejects.toThrow("different inputs");
});
it("resumes a saved receipt without another POST and records failed provider usage once", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "resume", crop), client = provider("receipt-resume");
  await db.toolInvocation.update({ where: { id: row.id }, data: { status: "running", providerRunId: "receipt-resume", startedAt: new Date() } });
  vi.mocked(client.read).mockResolvedValue({ id: "receipt-resume", nodeType: "crop_image", status: "FAILED", creditUsed: 1200, output: null });
  const result = await executeMediaTool(row.id, "retry", idleWait, signal(), client);
  expect(result.ok).toBe(false); expect(client.start).not.toHaveBeenCalled();
  await executeMediaTool(row.id, "again", idleWait, signal(), client);
  expect((await getOwnedRun(user, run.id)).applicationCredits).toBe(1200);
});
it("never retries an ambiguous start, including a later identical call", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "ambiguous", crop), client = provider();
  vi.mocked(client.start).mockRejectedValue(new ToolServiceError("UNKNOWN", "Receipt unknown. Contact support before retrying."));
  await executeMediaTool(row.id, "first", idleWait, signal(), client);
  await executeMediaTool(row.id, "replay", idleWait, signal(), client);
  expect((await db.toolInvocation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("unknown");
  const other = await registerInvocation(run.id, "new-call-same-input", crop);
  await executeMediaTool(other.id, "another", idleWait, signal(), client);
  expect(client.start).toHaveBeenCalledTimes(1);
});
it("recovers a crashed submitting claim as unknown and does not repost it", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "crash", crop), client = provider();
  await db.toolInvocation.update({ where: { id: row.id }, data: { status: "submitting", startedAt: new Date(Date.now() - 61_000) } });
  await executeMediaTool(row.id, "recovered", idleWait, signal(), client);
  expect(client.start).not.toHaveBeenCalled(); expect((await db.toolInvocation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("unknown");
});
it("backs off reads on 429 and leaves a receipt recoverable after repeated disconnects", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "retry-read", crop), client = provider();
  const completed = await client.read("unused"); vi.mocked(client.read).mockClear();
  vi.mocked(client.read).mockRejectedValueOnce(new ToolServiceError("RATE_LIMIT", "Busy")).mockResolvedValueOnce(completed);
  expect((await executeMediaTool(row.id, "worker", idleWait, signal(), client)).ok).toBe(true);
  expect(idleWait).toHaveBeenCalledWith(20); expect(client.start).toHaveBeenCalledTimes(1);
  const changed = prepareTool(registry, "crop_image", { image_url: "https://example.com/second.png", crop: { x: 0, y: 0, width: 64, height: 64 } });
  const second = await registerInvocation(run.id, "network", changed);
  const unavailable = provider(); vi.mocked(unavailable.read).mockRejectedValue(new ToolServiceError("UNAVAILABLE", "Disconnected"));
  await executeMediaTool(second.id, "network-worker", idleWait, signal(), unavailable);
  expect(unavailable.read).toHaveBeenCalledTimes(5); const saved = await db.toolInvocation.findUniqueOrThrow({ where: { id: second.id } });
  expect(saved.status).toBe("running"); expect(saved.providerRunId).toBeTruthy();
});
it("stops unsubmitted tools but reconciles already accepted work after the reply is cancelled", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "cancel-before", crop), client = provider();
  await stopRun(user, run.id);
  expect((await getOwnedRun(user, run.id)).status).toBe("cancelled");
  await executeMediaTool(row.id, "stopped", idleWait, signal(), client); expect(client.start).not.toHaveBeenCalled();
  expect((await db.toolInvocation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("cancelled");
  const next = await fixture(), accepted = await registerInvocation(next.run.id, "accepted", crop), acceptedClient = provider("accepted-id");
  await db.toolInvocation.update({ where: { id: accepted.id }, data: { status: "running", providerRunId: "accepted-id", startedAt: new Date() } });
  await stopRun(user, next.run.id);
  expect((await executeMediaTool(accepted.id, "late-result", idleWait, signal(), acceptedClient)).ok).toBe(true);
  expect((await getOwnedRun(user, next.run.id))).toMatchObject({ status: "cancelled", applicationCredits: 5000 });
});
it("persists ordered text/tool/text and assets through reload; later model failure preserves completed outputs", async () => {
  const { chat, run } = await fixture(false); let turn = 0;
  const model: TextModel = { async *stream() {
    if (++turn === 1) { yield { type: "text", text: "Cropping now." }; yield { type: "tool_calls", calls: [{ id: "crop-card", name: "crop_image", arguments: JSON.stringify(crop.input) }] }; }
    else { yield { type: "text", text: "The image is ready." }; throw new ModelError("TIMEOUT", "The final reply timed out."); }
  } };
  await expect(executeTurn(run.id, `run_${randomUUID()}`, model, signal(), vi.fn(), vi.fn(), async ids => Promise.all(ids.map(id => executeMediaTool(id, "child", idleWait, signal(), provider()))), registry)).rejects.toThrow("timed out");
  const saved = await getOwnedRun(user, run.id);
  expect(saved.status).toBe("failed"); expect(saved.assistantMessage.content.map(b => b.type)).toEqual(["thinking", "text", "tool", "thinking", "text"]);
  expect(saved.assistantMessage.tools?.[0]).toMatchObject({ status: "completed", credits: 5000 });
  const history = await listMessages(user, chat.id, { order: "desc", limit: 2 });
  expect(history.items[0].tools[0].output?.assets[0].url).toBe("https://example.com/cropped.png");
  await expect(getOwnedRun("different-owner", run.id)).rejects.toMatchObject({ status: 404 });
  await expect(listMessages("different-owner", chat.id, { order: "desc", limit: 2 })).rejects.toMatchObject({ status: 404 });
});
it("rolls back a mismatched message/run ownership relation", async () => {
  const a = await fixture(), b = await fixture();
  await expect(db.toolInvocation.create({ data: { runId: a.run.id, messageId: b.run.assistantMessage.id, chatId: b.chat.id, callId: "cross-chat", position: 0, ...crop } })).rejects.toThrow();
  expect(await db.toolInvocation.count({ where: { runId: a.run.id } })).toBe(0);
});
it("validates the stored output and preserves terminal settlement against races", async () => {
  const { run } = await fixture(), row = await registerInvocation(run.id, "settlement", crop);
  const output = { assets: [{ kind: "image" as const, url: image }], credits: 5000 };
  const results = await Promise.all([settleInvocation(row.id, "completed", null, 5000, output), settleInvocation(row.id, "completed", null, 5000, output)]);
  expect(results.map(toolResult).every(r => r.ok)).toBe(true); expect((await getOwnedRun(user, run.id)).applicationCredits).toBe(5000);
});

it("dispatches identical parallel model calls once and keeps ordered result identities", async () => {
  const { run } = await fixture(false); let turn = 0;
  const model: TextModel = { async *stream(messages) {
    if (++turn === 1) yield { type: "tool_calls", calls: ["first", "second"].map(id => ({ id, name: "crop_image", arguments: JSON.stringify(crop.input) })) };
    else {
      expect(messages.slice(-2).map(m => m.role === "tool" ? m.toolCallId : "")).toEqual(["first", "second"]);
      yield { type: "text", text: "The saved crop is ready." };
    }
  } };
  const executor = vi.fn(async (ids: string[]) => Promise.all(ids.map(id => executeMediaTool(id, "one-child", idleWait, signal(), provider()))));
  await executeTurn(run.id, `run_${randomUUID()}`, model, signal(), vi.fn(), vi.fn(), executor, registry);
  expect(executor.mock.calls[0][0]).toHaveLength(1);
  const saved = await getOwnedRun(user, run.id);
  expect(saved.applicationCredits).toBe(5000); expect(saved.assistantMessage.tools).toHaveLength(1);
  expect(saved.assistantMessage.content.filter(b => b.type === "tool")).toHaveLength(1);
});

it("corrects invalid model arguments before admission and submits only the validated replacement", async () => {
  const { run } = await fixture(false); let turn = 0;
  const model: TextModel = { async *stream(messages) {
    if (++turn === 1) yield { type: "tool_calls", calls: [{ id: "invalid", name: "crop_image", arguments: JSON.stringify({ image_url: image }) }] };
    else if (turn === 2) {
      expect(await db.toolInvocation.count({ where: { runId: run.id } })).toBe(0);
      expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ code: "INVALID_INPUT", retryable: true });
      yield { type: "tool_calls", calls: [{ id: "corrected", name: "crop_image", arguments: JSON.stringify(crop.input) }] };
    } else yield { type: "text", text: "Here is your crop." };
  } };
  const client = provider();
  const executor = vi.fn(async (ids: string[]) => Promise.all(ids.map(id => executeMediaTool(id, "corrected-child", idleWait, signal(), client))));
  await executeTurn(run.id, `run_${randomUUID()}`, model, signal(), vi.fn(), vi.fn(), executor, registry);
  expect(client.start).toHaveBeenCalledTimes(1); expect(executor).toHaveBeenCalledTimes(1);
  expect((await getOwnedRun(user, run.id)).assistantMessage.tools).toHaveLength(1);
});

it("persists generated audio through the provider-neutral asset receipt and owned history", async () => {
  const { run, chat } = await fixture();
  const row = await registerInvocation(run.id, "audio-contract-fixture", crop);
  // Contract fixture only: this does not claim Crop Image generates audio.
  const output = { assets: [{ kind: "audio" as const, url: "https://example.com/generated.wav" }], credits: 0 };
  const saved = toolResult(await settleInvocation(row.id, "completed", null, 0, output));
  expect(saved).toMatchObject({ ok: true, output });
  const history = await listMessages(user, chat.id, { order: "desc", limit: 2 });
  expect(history.items[0].tools[0].output).toEqual(output);
});

it("replays saved media dimensions and display credits without raw billing amounts", async () => {
  const { run, chat } = await fixture(), row = await registerInvocation(run.id, "history", crop);
  await settleInvocation(row.id, "completed", null, 12675, { assets: [{ kind: "image", url: image, width: 1254, height: 1254 }], credits: 12675 });
  await saveProgress(run.id, [{ type: "tool", invocationId: row.id }], 1);
  await finishRun(run.id, "completed");
  const next = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Crop the saved image", model: "openrouter/free" });
  const context = JSON.stringify(await contextForRun(next.id));
  expect(context).toContain("0.012675M credits"); expect(context).toContain("1254");
  expect(context).not.toContain('\\"credits\\":12675');
  expect((await getOwnedRun(user, run.id)).applicationCredits).toBe(12675);
});
