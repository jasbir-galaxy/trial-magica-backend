import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { GET as list, POST as create, OPTIONS } from "../src/app/api/app/v1/chats/route";
import { GET as detail } from "../src/app/api/app/v1/chats/[chatId]/route";
import { GET as messages } from "../src/app/api/app/v1/chats/[chatId]/messages/route";
import { getDatabase } from "../src/db/client";
import { MAX_JSON_BODY_BYTES } from "../src/http/input";

const { authenticateRequest } = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ authenticateRequest }) }));
vi.mock("server-only", () => ({}));
const ORIGIN = "http://localhost:3000";
const alice = `test_${randomUUID()}`;
const bob = `test_${randomUUID()}`;
const db = getDatabase();
const req = (path = "", method = "GET", body?: unknown, user = alice) => new Request(`http://localhost:3011/api/app/v1/chats${path}`, {
  method, headers: { Origin: ORIGIN, Authorization: `Bearer ${user}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const context = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
async function newChat(user = alice, title = "Test chat") {
  const response = await create(req("", "POST", { title }, user));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; title: string }>;
}
beforeAll(async () => { await db.$connect(); });
beforeEach(() => {
  vi.stubEnv("FRONTEND_ORIGIN", ORIGIN);
  vi.stubEnv("CLERK_SECRET_KEY", "test-placeholder");
  vi.stubEnv("CLERK_PUBLISHABLE_KEY", "test-placeholder");
  authenticateRequest.mockImplementation(async (request: Request) => ({
    isAuthenticated: true, toAuth: () => ({ userId: request.headers.get("authorization")!.slice(7) }),
  }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: { in: [alice, bob] } } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: { in: [alice, bob] } } } });
  await db.user.deleteMany({ where: { clerkUserId: { in: [alice, bob] } } });
});
afterAll(async () => { await db.$disconnect(); });

it("rejects unauthenticated requests for every endpoint", async () => {
  const request = req(); request.headers.delete("authorization");
  for (const response of await Promise.all([
    list(request), create(request), detail(request, context(randomUUID())), messages(request, context(randomUUID())),
  ])) expect(response.status).toBe(401);
  expect(authenticateRequest).not.toHaveBeenCalled();
});
it("creates and reloads a chat using only the verified identity", async () => {
  const response = await create(req("", "POST", {}));
  expect(response.status).toBe(201);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const chat = await response.json();
  expect(chat.title).toBe("New chat");
  expect(Object.keys(chat).sort()).toEqual(["createdAt", "deletedAt", "id", "isFavorite", "title", "updatedAt"]);
  expect(response.headers.get("Location")).toBe(`/api/app/v1/chats/${chat.id}`);
  expect(await (await detail(req(), context(chat.id))).json()).toEqual(chat);
  expect(await (await messages(req(), context(chat.id))).json()).toEqual({ items: [], nextCursor: null, hasMore: false });
  expect((await create(req("", "POST", { userId: bob }))).status).toBe(400);
});
it("deduplicates simultaneous creates and detects conflicting retries", async () => {
  const requestId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => create(req("", "POST", { title: "Same", requestId }))));
  expect(responses.map(r => r.status).sort()).toEqual([200, 200, 200, 201]);
  const chats = await Promise.all(responses.map(r => r.json()));
  expect(new Set(chats.map(c => c.id)).size).toBe(1);
  expect(await db.user.count({ where: { clerkUserId: alice } })).toBe(1);
  expect((await create(req("", "POST", { title: "Different", requestId }))).status).toBe(409);
  expect((await create(req("", "POST", { title: "Same", requestId }, bob))).status).toBe(201);
});
it("hides foreign chats and messages exactly like nonexistent chats", async () => {
  const chat = await newChat(alice);
  for (const id of [chat.id, randomUUID()]) {
    for (const handler of [detail, messages]) {
      const response = await handler(req("", "GET", undefined, bob), context(id));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", message: "Chat not found." });
    }
  }
  expect(await (await list(req("", "GET", undefined, bob))).json()).toEqual({ items: [], hasMore: false, nextCursor: null });
});
it("paginates chats with timestamp ties without mixing owners or repeating rows", async () => {
  const owned = await Promise.all(Array.from({ length: 5 }, () => newChat()));
  await newChat(bob);
  await db.chat.updateMany({ where: { id: { in: owned.map(c => c.id) } }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const response = await list(req(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
    expect(response.status).toBe(200);
    const page = await response.json(); ids.push(...page.items.map((c: { id: string }) => c.id));
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.hasMore).toBe(page.nextCursor !== null);
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(owned.map(c => c.id).sort().reverse());
});
it("paginates persisted structured messages chronologically, including timestamp ties", async () => {
  const chat = await newChat();
  const ids = Array.from({ length: 3 }, () => randomUUID()).sort();
  await db.message.createMany({ data: ids.map(id => ({
    id, chatId: chat.id, role: "user" as const, status: "completed" as const,
    content: [{ type: "text", text: "Hello" }], createdAt: new Date("2026-01-01T00:00:00Z"),
  })) });
  const first = await (await messages(req("?limit=2"), context(chat.id))).json();
  expect(first.items.map((m: { id: string }) => m.id)).toEqual(ids.slice(0, 2));
  expect(first.items[0].content).toEqual([{ type: "text", text: "Hello" }]);
  const last = await (await messages(req(`?limit=2&cursor=${first.nextCursor}`), context(chat.id))).json();
  expect(last.items.map((m: { id: string }) => m.id)).toEqual(ids.slice(2));
  expect(last.hasMore).toBe(false);
  const other = await newChat();
  expect((await messages(req(`?cursor=${first.nextCursor}`), context(other.id))).status).toBe(400);
});
it.each(["?limit=0", "?limit=101", "?limit=1.5", "?limit=", "?cursor=invalid", "?cursor=%3D"])("rejects malformed pagination %s", async (query) => {
  expect((await list(req(query))).status).toBe(400);
});
it.each([{ title: " " }, { title: "x".repeat(121) }, { requestId: "bad" }, { title: null }])("rejects invalid chat fields %j", async body => {
  expect((await create(req("", "POST", body))).status).toBe(400);
});
it("rejects invalid IDs, malformed JSON, unsupported media, and oversized streamed bodies", async () => {
  expect((await detail(req(), context("invalid"))).status).toBe(400);
  const malformed = req("", "POST", {});
  expect((await create(new Request(malformed.url, { method: "POST", headers: malformed.headers, body: "{" }))).status).toBe(400);
  expect((await create(new Request(malformed.url, { method: "POST", headers: { Authorization: `Bearer ${alice}` }, body: "{}" }))).status).toBe(415);
  expect((await create(req("", "POST", { title: "x".repeat(MAX_JSON_BODY_BYTES) }))).status).toBe(413);
});
it("allows unauthenticated creation preflight", async () => {
  const response = await OPTIONS(new Request(req().url, { method: "OPTIONS", headers: {
    Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type",
  } }));
  expect(response.status).toBe(204);
  expect(authenticateRequest).not.toHaveBeenCalled();
});
it("does not leak database errors", async () => {
  await newChat();
  vi.spyOn(db.chat, "findMany").mockRejectedValueOnce(new Error("private database details"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await list(req());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private database details");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
});
it("treats invalid stored content as a server error rather than blaming the request", async () => {
  const chat = await newChat();
  await db.message.create({ data: { chatId: chat.id, role: "user", status: "completed", content: [{ type: "unknown" }] } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect((await messages(req(), context(chat.id))).status).toBe(500);
});
