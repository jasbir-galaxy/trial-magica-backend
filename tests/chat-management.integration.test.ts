import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat, deleteChat, favoriteChat, getChat, listChats, listMessages, restoreChat } from "../src/chats/service";
import { createTurn, finishRun, getOwnedRun, latestRun } from "../src/agent/run-store";
import { createUpload, cancelUpload } from "../src/uploads/store";
import { PATCH, DELETE, OPTIONS } from "../src/app/api/app/v1/chats/[chatId]/route";
import { POST as restore } from "../src/app/api/app/v1/chats/[chatId]/restore/route";
import { ChatListQuerySchema } from "../src/contracts/chats";
vi.mock("server-only", () => ({}));
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ authenticateRequest: authenticate }) }));
const db = getDatabase(), alice = `management_${randomUUID()}`, bob = `management_${randomUUID()}`;
const owned = { user: { clerkUserId: { in: [alice, bob] } } };
const create = async (title = "Project notes", user = alice) => (await createChat(user, { title })).chat;
const request = (method: string, body?: unknown, user = alice) => new Request("http://localhost:3001/api/app/v1/chats", { method, headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const context = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const turn = (text = "Hello") => ({ requestId: randomUUID(), text, model: "openrouter/free" as const });
const upload = (chatId: string) => ({ chatId, requestId: randomUUID(), files: [{ id: randomUUID(), name: "photo.png", mimeType: "image/png" as const, size: 100 }] });
beforeEach(() => {
  for (const [key, value] of Object.entries({ FRONTEND_ORIGIN: "http://localhost:3000", CLERK_SECRET_KEY: "test", CLERK_PUBLISHABLE_KEY: "test", TRIAL_INITIAL_CREDITS: "1000000", TRANSLOADIT_PLAN: "community", TRANSLOADIT_AUTH_KEY: "a".repeat(32), TRANSLOADIT_AUTH_SECRET: "test", UPLOAD_S3_ENDPOINT: "https://storage.example.test", UPLOAD_S3_REGION: "test", UPLOAD_S3_BUCKET: "test", UPLOAD_S3_ACCESS_KEY_ID: "test", UPLOAD_S3_SECRET_ACCESS_KEY: "test", UPLOAD_PUBLIC_API_ORIGIN: "" })) vi.stubEnv(key, value);
  authenticate.mockImplementation(async (r: Request) => ({ isAuthenticated: true, toAuth: () => ({ userId: r.headers.get("authorization")!.slice(7) }) }));
});
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: owned } }); await db.creditReservation.deleteMany({ where: { account: owned } }); await db.creditAccount.deleteMany({ where: owned });
  await db.toolInvocation.deleteMany({ where: { run: owned } }); await db.agentRun.deleteMany({ where: owned });
  await db.message.deleteMany({ where: { chat: owned } }); await db.attachment.deleteMany({ where: owned }); await db.uploadBatch.deleteMany({ where: owned });
  await db.chat.deleteMany({ where: owned }); await db.user.deleteMany({ where: { clerkUserId: { in: [alice, bob] } } });
  await db.uploadQuota.deleteMany({ where: { uploads: { none: {} } } }); vi.unstubAllEnvs(); vi.clearAllMocks();
});
afterAll(() => db.$disconnect());
it("searches indexed titles and only visible message text with ownership isolation", async () => {
  const title = await create("Orchid project"), content = await create("Other notes"), hidden = await create("Nothing here");
  await create("Orchid private", bob);
  await db.message.create({ data: { chatId: content.id, role: "user", status: "completed", content: [{ type: "text", text: "Remember ORCHID tomorrow" }] } });
  await db.message.create({ data: { chatId: hidden.id, role: "tool", status: "completed", content: [{ type: "attachment", attachmentId: randomUUID(), name: "orchid" }] } });
  const result = await listChats(alice, { limit: 20, q: "orchid" });
  expect(result.items.map(c => c.id).sort()).toEqual([title.id, content.id].sort());
  expect((await listChats(alice, { limit: 20, q: "' OR 1=1 --" })).items).toEqual([]);
  expect((await listChats(alice, { limit: 20, q: "!!!" })).items).toEqual([]);
});
it("keeps favorite writes idempotent and cursor scopes distinct across filters", async () => {
  const chats = await Promise.all([create("Orchid one"), create("Orchid two"), create("Orchid three")]);
  await db.chat.updateMany({ where: { id: { in: chats.map(c => c.id) } }, data: { createdAt: new Date("2026-01-01") } });
  await Promise.all(chats.map(c => favoriteChat(alice, c.id, true))); await favoriteChat(alice, chats[0].id, true);
  const page = await listChats(alice, { limit: 1, view: "favorites", q: "orchid" });
  await favoriteChat(alice, page.items[0].id, false);
  const next = await listChats(alice, { limit: 5, view: "favorites", q: "orchid", cursor: page.nextCursor! });
  expect(new Set([page.items[0].id, ...next.items.map(c => c.id)]).size).toBe(3);
  await expect(listChats(alice, { limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400 });
  await expect(listChats(alice, { limit: 1, view: "favorites", q: "different", cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400 });
});
it("moves chats to Trash idempotently and restores history and favorites", async () => {
  const chat = await create(); await favoriteChat(alice, chat.id, true);
  await db.message.create({ data: { chatId: chat.id, role: "user", status: "completed", content: [{ type: "text", text: "Retained history" }] } });
  const first = await deleteChat(alice, chat.id); expect(await deleteChat(alice, chat.id)).toEqual(first);
  expect((await listChats(alice, { limit: 20 })).items).toEqual([]);
  expect((await listChats(alice, { limit: 20, view: "favorites" })).items).toEqual([]);
  expect((await listChats(alice, { limit: 20, view: "trash", q: "retained" })).items.map(c => c.id)).toEqual([chat.id]);
  await expect(getChat(alice, chat.id)).rejects.toMatchObject({ status: 404 });
  await expect(listMessages(alice, chat.id, { limit: 20, order: "desc" })).rejects.toMatchObject({ status: 404 });
  await expect(favoriteChat(alice, chat.id, false)).rejects.toMatchObject({ status: 404 });
  expect(await restoreChat(alice, chat.id)).toMatchObject({ deletedAt: null, isFavorite: true });
  expect(await restoreChat(alice, chat.id)).toMatchObject({ deletedAt: null });
  expect((await listMessages(alice, chat.id, { limit: 20, order: "desc" })).items).toHaveLength(1);
});
it("does not expose foreign chats through mutations or Trash", async () => {
  const chat = await create(); await deleteChat(alice, chat.id);
  for (const id of [chat.id, randomUUID()]) {
    for (const mutation of [() => deleteChat(bob, id), () => restoreChat(bob, id), () => favoriteChat(bob, id, true)]) await expect(mutation()).rejects.toMatchObject({ status: 404 });
  }
  expect((await listChats(bob, { limit: 20, view: "trash" })).items).toEqual([]);
});
it("blocks deletion during active replies and denies all run access after deletion", async () => {
  const chat = await create(), run = await createTurn(alice, chat.id, turn());
  await expect(deleteChat(alice, chat.id)).rejects.toMatchObject({ code: "CHAT_BUSY" });
  await finishRun(run.id, "cancelled"); await deleteChat(alice, chat.id);
  await expect(createTurn(alice, chat.id, turn())).rejects.toMatchObject({ status: 404 });
  await expect(getOwnedRun(alice, run.id)).rejects.toMatchObject({ status: 404 });
  await expect(latestRun(alice, chat.id)).rejects.toMatchObject({ status: 404 });
});
it("blocks deletion while an unresolved tool may still incur usage", async () => {
  const chat = await create(), run = await createTurn(alice, chat.id, turn()); await finishRun(run.id, "failed");
  await db.toolInvocation.create({ data: { runId: run.id, messageId: run.assistantMessage.id, chatId: chat.id, callId: "unknown-call", name: "crop_image", label: "Crop Image", position: 0, status: "unknown", input: {}, inputSchema: {}, schemaHash: "a".repeat(64), inputHash: "b".repeat(64) } });
  await expect(deleteChat(alice, chat.id)).rejects.toMatchObject({ code: "CHAT_BUSY" });
});
it("serializes delete against concurrent send without creating work in Trash", async () => {
  const chat = await create();
  const result = await Promise.allSettled([deleteChat(alice, chat.id), createTurn(alice, chat.id, turn())]);
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  expect(await db.agentRun.count({ where: { chatId: chat.id } })).toBe(row.deletedAt ? 0 : 1);
});
it("protects active uploads and refuses upload admission after deletion", async () => {
  const chat = await create(), started = await createUpload(alice, upload(chat.id));
  await expect(deleteChat(alice, chat.id)).rejects.toMatchObject({ code: "CHAT_BUSY" });
  await cancelUpload(alice, started.upload.id); await deleteChat(alice, chat.id);
  await expect(createUpload(alice, upload(chat.id))).rejects.toMatchObject({ status: 404 });
});
it("serializes delete against concurrent upload admission", async () => {
  const chat = await create();
  const result = await Promise.allSettled([deleteChat(alice, chat.id), createUpload(alice, upload(chat.id))]);
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
  expect(await db.uploadBatch.count({ where: { chatId: chat.id } })).toBe(row.deletedAt ? 0 : 1);
});
it("validates REST mutations and permits unauthenticated preflight", async () => {
  const chat = await create();
  expect((await PATCH(request("PATCH", { isFavorite: "true" }), context(chat.id))).status).toBe(400);
  const favorite = await PATCH(request("PATCH", { isFavorite: true }), context(chat.id));
  expect(favorite.status).toBe(200); expect(await favorite.json()).toMatchObject({ isFavorite: true });
  expect((await DELETE(request("DELETE", undefined, bob), context(chat.id))).status).toBe(404);
  expect((await DELETE(request("DELETE"), context(chat.id))).status).toBe(200);
  expect((await restore(request("POST"), context(chat.id))).status).toBe(200);
  for (const method of ["PATCH", "DELETE"]) expect((await OPTIONS(new Request(request(method).url, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,content-type" } }))).status).toBe(204);
  for (const handler of [PATCH, DELETE, restore]) {
    const req = request("POST", {}); req.headers.delete("authorization");
    expect((await handler(req, context(chat.id))).status).toBe(401);
  }
  expect(ChatListQuerySchema.safeParse({ q: "x".repeat(121) }).success).toBe(false);
  expect(ChatListQuerySchema.safeParse({ view: "unknown" }).success).toBe(false);
});
