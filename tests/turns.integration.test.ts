import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat } from "../src/chats/service";
import { createTurn, finishRun, getOwnedRun, saveProgress, stopRun } from "../src/agent/run-store";
import { executeTurn } from "../src/agent/execute-turn";
import { POST as send, GET as read } from "../src/app/api/app/v1/chats/[chatId]/turns/route";
import { POST as stop } from "../src/app/api/app/v1/runs/[runId]/stop/route";
import { POST as token } from "../src/app/api/app/v1/runs/[runId]/realtime/route";
import { GET as messages } from "../src/app/api/app/v1/chats/[chatId]/messages/route";
import { ModelError, type TextModel } from "../src/agent/model";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), trigger: vi.fn(), token: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ authenticateRequest: mocks.authenticate }) }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger }, idempotencyKeys: { create: async (key: string) => key }, auth: { createPublicToken: mocks.token } }));
const db = getDatabase();
const alice = `turn_test_${randomUUID()}`, bob = `turn_test_${randomUUID()}`;
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const runCtx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const input = (text = "Hello") => ({ requestId: randomUUID(), text, model: "openrouter/free" as const });
const req = (method = "GET", body?: unknown, user = alice, query = "") => new Request(`http://localhost:3001/api/app/v1/chats${query}`, { method,
  headers: { Authorization: `Bearer ${user}`, Origin: "http://localhost:3000", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const chat = async () => (await createChat(alice, { title: "Turn test" })).chat.id;
beforeEach(() => {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "1000000");
  vi.stubEnv("FRONTEND_ORIGIN", "http://localhost:3000"); vi.stubEnv("CLERK_SECRET_KEY", "test"); vi.stubEnv("CLERK_PUBLISHABLE_KEY", "test");
  vi.stubEnv("TRIGGER_SECRET_KEY", "test"); vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test"); vi.stubEnv("OPENROUTER_API_KEY", "test");
  mocks.authenticate.mockImplementation(async (r: Request) => ({ isAuthenticated: true, toAuth: () => ({ userId: r.headers.get("authorization")!.slice(7) }) }));
  mocks.trigger.mockImplementation(async () => ({ id: `run_${randomUUID()}` })); mocks.token.mockResolvedValue("scoped-fixture-token");
});
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: alice } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: alice } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: alice } } });
  await db.waitpoint.deleteMany({ where: { tool: { run: { chat: { user: { clerkUserId: alice } } } } } });
  await db.agentRun.deleteMany({ where: { chat: { user: { clerkUserId: alice } } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: alice } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: alice } } });
  await db.user.deleteMany({ where: { clerkUserId: alice } });
  vi.unstubAllEnvs(); vi.clearAllMocks();
});
afterAll(async () => db.$disconnect());
it("accepts authenticated send and returns persisted IDs with read access scoped to exactly that run", async () => {
  const id = await chat(), payload = input();
  const response = await send(req("POST", payload), ctx(id)); expect(response.status).toBe(202);
  const body = await response.json(); expect(body.run.status).toBe("queued");
  expect(body.run.userMessage.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(mocks.token).toHaveBeenCalledWith({ scopes: { read: { runs: [body.run.triggerRunId] } }, expirationTime: "15m" });
  const replay = await (await send(req("POST", payload), ctx(id))).json(); expect(replay.run.id).toBe(body.run.id);
  expect(mocks.trigger).toHaveBeenCalledTimes(1); expect(await db.message.count({ where: { chatId: id } })).toBe(2);
  expect((await read(req(), ctx(id))).status).toBe(200);
});
it("concurrent identical sends create one pair; different sends cannot create a second active run", async () => {
  const id = await chat(), payload = input();
  const results = await Promise.all(Array.from({ length: 4 }, () => createTurn(alice, id, payload)));
  expect(new Set(results.map(r => r.id)).size).toBe(1);
  await expect(createTurn(alice, id, input("Other"))).rejects.toMatchObject({ status: 409 });
  await expect(createTurn(alice, id, { ...payload, text: "Changed" })).rejects.toMatchObject({ status: 409 });
  expect(await db.agentRun.count({ where: { chatId: id } })).toBe(1);
});
it("hides another owner's run and blocks send, stop, token mint and reads", async () => {
  const id = await chat(), run = await createTurn(alice, id, input());
  expect((await send(req("POST", input(), bob), ctx(id))).status).toBe(404);
  expect((await read(req("GET", undefined, bob), ctx(id))).status).toBe(404);
  expect((await stop(req("POST", {}, bob), runCtx(run.id))).status).toBe(404);
  expect((await token(req("POST", {}, bob), runCtx(run.id))).status).toBe(404);
  expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled();
});
it("rejects invalid message and paid configuration before persistence", async () => {
  const id = await chat();
  for (const payload of [{ ...input(), text: " " }, { ...input(), model: "paid/model" }, { ...input(), attachments: [] }, { ...input(), text: "x".repeat(32001) }]) {
    expect((await send(req("POST", payload), ctx(id))).status).toBe(400);
  }
  expect(await db.agentRun.count({ where: { chatId: id } })).toBe(0);
});
it("keeps an accepted turn queued after ambiguous dispatch and recovers with the same key", async () => {
  const id = await chat(); mocks.trigger.mockRejectedValueOnce(new Error("private network error"));
  const response = await send(req("POST", input()), ctx(id)); expect(response.status).toBe(202);
  const { run } = await response.json(); expect(run.triggerRunId).toBeNull();
  await db.agentRun.update({ where: { id: run.id }, data: { dispatchAfter: new Date(0) } });
  const recovered = await (await read(req(), ctx(id))).json(); expect(recovered.run.triggerRunId).toMatch(/^run_/);
  expect(mocks.trigger.mock.calls[0][2].idempotencyKey).toBe(mocks.trigger.mock.calls[1][2].idempotencyKey);
  expect(await db.message.count({ where: { chatId: id } })).toBe(2);
});
it("persists final text, actual routed model, zero credits and usage, and rejects duplicate execution", async () => {
  const id = await chat(), run = await createTurn(alice, id, input());
  const generate = vi.fn(async function* () { yield { type: "text" as const, text: "Hello back" }; yield { type: "usage" as const, usage: { actualModel: "fixture/free", promptTokens: 12, completionTokens: 4 } }; });
  const model: TextModel = { stream: generate };
  await executeTurn(run.id, "run_fixture", model, new AbortController().signal, vi.fn(), vi.fn());
  await executeTurn(run.id, "run_fixture", model, new AbortController().signal, vi.fn(), vi.fn());
  expect(generate).toHaveBeenCalledTimes(1);
  const saved = await getOwnedRun(alice, run.id); expect(saved).toMatchObject({ status: "completed", actualModel: "fixture/free", promptTokens: 12, completionTokens: 4, applicationCredits: 0 });
  expect(saved.assistantMessage.content).toEqual([{ type: "text", text: "Hello back" }]);
  const first = await (await messages(req("GET", undefined, alice, "?order=desc&limit=1"), ctx(id))).json();
  expect(first.items[0].id).toBe(saved.assistantMessage.id);
  const older = await (await messages(req("GET", undefined, alice, `?order=desc&limit=1&cursor=${first.nextCursor}`), ctx(id))).json();
  expect(older.items[0].id).toBe(saved.userMessage.id);
});
it("retains partial text on failure and settles cancellation once despite late completion", async () => {
  const id = await chat(), run = await createTurn(alice, id, input());
  const model: TextModel = { async *stream() { yield { type: "text", text: "Partial" }; throw new ModelError("TIMEOUT", "This reply timed out. Please try again."); } };
  await expect(executeTurn(run.id, "run_failed_fixture", model, new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow("timed out");
  const failed = await getOwnedRun(alice, run.id); expect(failed.status).toBe("failed"); expect((failed.assistantMessage.content[0] as { text: string }).text).toBe("Partial"); expect(failed.assistantMessage.error).toContain("timed out");
  const second = await createTurn(alice, id, input());
  await db.agentRun.update({ where: { id: second.id }, data: { status: "running", startedAt: new Date() } });
  await saveProgress(second.id, "Keep", 1); await stopRun(alice, second.id); await finishRun(second.id, "completed"); await finishRun(second.id, "failed");
  const cancelled = await getOwnedRun(alice, second.id); expect(cancelled.status).toBe("cancelled"); expect((cancelled.assistantMessage.content[0] as { text: string }).text).toBe("Keep");
  await saveProgress(second.id, "Late", 2); expect(((await getOwnedRun(alice, second.id)).assistantMessage.content[0] as { text: string }).text).toBe("Keep");
});
it("stops a queued run immediately and times out a stranded run without removing messages", async () => {
  const id = await chat(), run = await createTurn(alice, id, input());
  expect((await stopRun(alice, run.id)).status).toBe("cancelled");
  const next = await createTurn(alice, id, input());
  await db.agentRun.update({ where: { id: next.id }, data: { status: "running", startedAt: new Date(Date.now() - 1_900_000) } });
  const state = await (await read(req(), ctx(id))).json(); expect(state.run.status).toBe("failed"); expect(state.run.error).toContain("timed out");
  expect(await db.message.count({ where: { chatId: id } })).toBe(4);
});

it("requires a verified session before send, read, stop, or realtime access", async () => {
  const request = new Request("http://localhost:3001/api/app/v1/chats", { method: "POST" });
  for (const response of await Promise.all([send(request, ctx(randomUUID())), read(request, ctx(randomUUID())), stop(request, runCtx(randomUUID())), token(request, runCtx(randomUUID()))])) expect(response.status).toBe(401);
  expect(mocks.trigger).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled();
});
