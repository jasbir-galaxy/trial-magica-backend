import { expect, it } from "vitest";
import { CreateChatSchema, MessageContentSchema, PageQuerySchema } from "../src/contracts/chats";
import { decodeCursor, makePage } from "../src/chats/pagination";

it("uses bounded pagination and normalized titles", () => {
  expect(PageQuerySchema.parse({})).toEqual({ limit: 20 });
  expect(CreateChatSchema.parse({ title: "  Planning  " })).toEqual({ title: "Planning" });
});
it("validates text blocks and rejects unknown shapes", () => {
  expect(MessageContentSchema.safeParse([{ type: "text", text: "Hello" }]).success).toBe(true);
  for (const content of [[{ type: "text", text: "" }], [{ type: "html", text: "x" }], "text", [{ type: "text", text: "x", extra: true }]]) {
    expect(MessageContentSchema.safeParse(content).success).toBe(false);
  }
});
it("uses a versioned cursor with a stable boundary and validates its scope", () => {
  const row = { id: "00000000-0000-4000-8000-000000000001", createdAt: new Date("2026-01-01T00:00:00.123Z") };
  const page = makePage([row, row], 1, "chats");
  expect(decodeCursor(page.nextCursor!, "chats")).toEqual(row);
  expect(() => decodeCursor(page.nextCursor!, "another-chat")).toThrow("cursor is invalid");
  expect(makePage([], 20, "chats")).toEqual({ items: [], hasMore: false, nextCursor: null });
});
