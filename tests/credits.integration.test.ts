import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { accountForUser, creditHistory, reserve, settleReservation } from "../src/credits/store";
import { createChat } from "../src/chats/service";
import { createTurn, finishRun } from "../src/agent/run-store";
vi.mock("server-only", () => ({}));
const db = getDatabase(), user = `credit_test_${randomUUID()}`;
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.agentRun.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.user.deleteMany({ where: { clerkUserId: user } }); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());
async function fixture(balance = 10000) {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", String(balance));
  const { chat } = await createChat(user, { title: "Credit test" });
  const run = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Hello", model: "openrouter/free" });
  const owner = await db.user.findUniqueOrThrow({ where: { clerkUserId: user } });
  return { chat, run, owner };
}
it("grants once under concurrent first reads and refunds text admission once", async () => {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "10000");
  await Promise.all(Array.from({ length: 4 }, () => accountForUser(user)));
  const { run } = await fixture();
  expect(await accountForUser(user)).toMatchObject({ balance: 10000, reserved: 1000, available: 9000 });
  await Promise.all([finishRun(run.id, "completed"), finishRun(run.id, "completed")]);
  expect(await accountForUser(user)).toMatchObject({ balance: 10000, reserved: 0 });
  expect((await creditHistory(user, { limit: 10 })).items.filter(e => e.kind === "grant")).toHaveLength(1);
});
it("rejects insufficient admission atomically before messages persist", async () => {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "0"); const { chat } = await createChat(user, { title: "Unfunded" });
  await expect(createTurn(user, chat.id, { requestId: randomUUID(), text: "No funds", model: "openrouter/free" })).rejects.toMatchObject({ status: 402 });
  expect(await db.message.count({ where: { chatId: chat.id } })).toBe(0);
});
it.each([2000, 7000])("settles actual usage %i above or below the estimate exactly once", async actual => {
  const { run, owner } = await fixture();
  await db.$transaction(tx => reserve(tx, owner.id, run.id, "cost", 5000));
  await Promise.all([db.$transaction(tx => settleReservation(tx, "cost", actual)), db.$transaction(tx => settleReservation(tx, "cost", actual))]);
  expect(await accountForUser(user)).toMatchObject({ balance: 10000 - actual, reserved: 1000 });
});
it("serializes concurrent holds and records incurred overage without an extra approval", async () => {
  const { run, owner } = await fixture();
  const results = await Promise.allSettled(["a", "b"].map(key => db.$transaction(tx => reserve(tx, owner.id, run.id, key, 6000))));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const key = results[0].status === "fulfilled" ? "a" : "b";
  await db.$transaction(tx => settleReservation(tx, key, 12000));
  expect(await accountForUser(user)).toMatchObject({ balance: -2000, available: 0 });
  await expect(db.$transaction(tx => reserve(tx, owner.id, run.id, "blocked", 1))).rejects.toMatchObject({ status: 402 });
});
it("paginates ledger reads and does not leak another account", async () => {
  const { run } = await fixture(); await finishRun(run.id, "cancelled");
  const first = await creditHistory(user, { limit: 2 });
  expect(first.hasMore).toBe(true);
  const second = await creditHistory(user, { limit: 2, cursor: first.nextCursor! });
  expect(new Set([...first.items, ...second.items].map(i => i.id)).size).toBe(3);
  expect((await creditHistory("unknown-owner", { limit: 10, cursor: first.nextCursor! })).items).toEqual([]);
});
