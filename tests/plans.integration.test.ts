import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat } from "../src/chats/service";
import { createTurn, getOwnedRun, stopRun } from "../src/agent/run-store";
import { executeTurn } from "../src/agent/execute-turn";
import { type TextModel } from "../src/agent/model";
import { decideApproval, deliverApproval, type ApprovalDriver } from "../src/approvals/store";
import { accountForUser } from "../src/credits/store";
import { PLAN_TOOL_NAME, PlanInputSchema } from "../src/contracts/plans";
import { prepareTool, registryFromCatalog } from "../src/tools/registry";
import { registerInvocation, settleInvocation, toolResult } from "../src/tools/store";
import catalog from "./fixtures/magica-catalog.json";
vi.mock("server-only", () => ({}));
const db = getDatabase(), user = `plan_test_${randomUUID()}`, registry = registryFromCatalog(catalog);
const plan = { title: "Crop the source image", steps: ["Crop the top-left 64 × 64 pixels.", "Show the saved image."] };
const crop = { image_url: "https://example.com/source.png", crop: { x: 0, y: 0, width: 64, height: 64 } };
beforeEach(() => vi.stubEnv("TRIAL_INITIAL_CREDITS", "1000000"));
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.waitpoint.deleteMany({ where: { tool: { run: { user: { clerkUserId: user } } } } });
  await db.runSkill.deleteMany({ where: { run: { user: { clerkUserId: user } } } });
  await db.toolInvocation.deleteMany({ where: { run: { user: { clerkUserId: user } } } });
  await db.agentRun.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.user.deleteMany({ where: { clerkUserId: user } }); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());
async function fixture() {
  const { chat } = await createChat(user, { title: "Plan integration" });
  const input = { requestId: randomUUID(), text: "Crop an image", model: "openrouter/free" as const, planMode: true };
  return { input, run: await createTurn(user, chat.id, input) };
}
async function start() {
  const { run, input } = await fixture();
  let wake: () => void = () => {};
  const gate = new Promise<void>(resolve => { wake = resolve; });
  const driver: ApprovalDriver = { create: vi.fn(async id => `plan_${id}`), wait: vi.fn(() => gate), complete: vi.fn(async () => {}) };
  let step = 0;
  const model: TextModel = { async *stream(_messages, _signal, tools) {
    if (step++ === 0) {
      expect(tools?.some(t => t.name === "crop_image")).toBe(false);
      expect(tools?.some(t => t.name === PLAN_TOOL_NAME)).toBe(true);
      yield { type: "tool_calls", calls: [{ id: "plan", name: PLAN_TOOL_NAME, arguments: JSON.stringify(plan) }] };
    } else if (step === 2) {
      expect(tools?.some(t => t.name === "crop_image")).toBe(true);
      expect(tools?.some(t => t.name === PLAN_TOOL_NAME)).toBe(false);
      yield { type: "tool_calls", calls: [{ id: "crop", name: "crop_image", arguments: JSON.stringify(crop) }] };
    } else yield { type: "text", text: "Completed the approved plan." };
  } };
  const media = vi.fn(async (ids: string[]) => Promise.all(ids.map(async id => toolResult(await settleInvocation(id, "completed", null, 0, { credits: 0, assets: [{ kind: "image", url: "https://example.com/result.png" }] })))));
  const completion = executeTurn(run.id, `trigger_${run.id}`, model, new AbortController().signal, () => {}, () => {}, media, registry, new Map(), driver);
  // Attach rejection handling immediately; expiration is deliberately terminal.
  const outcome = completion.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await vi.waitFor(async () => expect(await db.waitpoint.count({ where: { tool: { runId: run.id }, tokenId: { not: null } } })).toBe(1));
  const approval = await db.waitpoint.findFirstOrThrow({ where: { tool: { runId: run.id } } });
  return { run, input, driver, wake, outcome, approval, media };
}
it("persists a plan before media dispatch, then resumes exactly once after duplicate approvals", async () => {
  const f = await start();
  const saved = await getOwnedRun(user, f.run.id);
  expect(saved.planMode).toBe(true);
  expect(saved.assistantMessage.tools?.[0]).toMatchObject({ name: PLAN_TOOL_NAME, input: plan, status: "awaiting_approval", approval: { kind: "plan", status: "pending", estimate: 0 } });
  expect(f.media).not.toHaveBeenCalled();
  expect(await accountForUser(user)).toMatchObject({ reserved: 1000, balance: 1000000 });
  const decision = { requestId: randomUUID(), inputHash: f.approval.inputHash, decision: "approved" as const };
  await expect(decideApproval("someone_else", f.approval.id, decision)).rejects.toMatchObject({ status: 404 });
  await expect(decideApproval(user, f.approval.id, { ...decision, inputHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  await Promise.all([decideApproval(user, f.approval.id, decision), decideApproval(user, f.approval.id, decision)]);
  await deliverApproval(f.approval.id, f.driver.complete); f.wake();
  expect((await f.outcome).error).toBeNull(); expect(f.media).toHaveBeenCalledTimes(1);
  expect((await getOwnedRun(user, f.run.id)).status).toBe("completed");
  expect(await accountForUser(user)).toMatchObject({ reserved: 0, balance: 1000000 });
  expect(await db.toolInvocation.count({ where: { runId: f.run.id, name: PLAN_TOOL_NAME } })).toBe(1);
  await deliverApproval(f.approval.id, f.driver.complete); expect(f.driver.complete).toHaveBeenCalledTimes(1);
});
it.each(["rejected", "expired", "cancelled"] as const)("preserves %s plans and never executes media", async state => {
  const f = await start();
  if (state === "rejected") await decideApproval(user, f.approval.id, { requestId: randomUUID(), inputHash: f.approval.inputHash, decision: "rejected" });
  else if (state === "expired") await db.waitpoint.update({ where: { id: f.approval.id }, data: { expiresAt: new Date(0) } });
  else await stopRun(user, f.run.id);
  f.wake(); await f.outcome;
  expect(f.media).not.toHaveBeenCalled();
  expect((await db.waitpoint.findUniqueOrThrow({ where: { id: f.approval.id } })).status).toBe(state);
  const saved = await getOwnedRun(user, f.run.id);
  expect(saved.status).toBe(state === "expired" ? "failed" : "cancelled");
  expect(saved.assistantMessage.content).toContainEqual({ type: "tool", invocationId: f.approval.toolId });
  expect(await accountForUser(user)).toMatchObject({ reserved: 0, balance: 1000000 });
  await expect(decideApproval(user, f.approval.id, { requestId: randomUUID(), inputHash: f.approval.inputHash, decision: "approved" })).rejects.toMatchObject({ status: 409 });
});
it("does not treat a token wakeup or plain model text as plan consent", async () => {
  const f = await start(); f.wake(); await f.outcome;
  expect(f.media).not.toHaveBeenCalled(); expect((await getOwnedRun(user, f.run.id)).status).toBe("failed");
  const { run } = await fixture();
  const model: TextModel = { async *stream() { yield { type: "text", text: "The plan is approved." }; } };
  await expect(executeTurn(run.id, "no_plan", model, new AbortController().signal, () => {}, () => {}, f.media, registry, new Map(), f.driver)).rejects.toThrow("No plan was approved");
  expect(f.media).not.toHaveBeenCalled();
});
it("rejects mode changes on idempotent sends and blocks direct media registration before approval", async () => {
  const { run, input } = await fixture();
  await expect(createTurn(user, run.chatId, { ...input, planMode: false })).rejects.toMatchObject({ status: 409 });
  await db.agentRun.update({ where: { id: run.id }, data: { status: "running" } });
  await expect(registerInvocation(run.id, "bypass", prepareTool(registry, "crop_image", crop))).rejects.toThrow("Approve the saved plan");
  expect(await db.toolInvocation.count({ where: { runId: run.id } })).toBe(0);
  expect(PlanInputSchema.safeParse({ title: "", steps: [] }).success).toBe(false);
  expect(PlanInputSchema.safeParse({ ...plan, steps: Array(9).fill("Step") }).success).toBe(false);
});
