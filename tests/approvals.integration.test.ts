import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat } from "../src/chats/service";
import { createTurn, getOwnedRun, stopRun } from "../src/agent/run-store";
import { registerInvocation } from "../src/tools/store";
import { executeMediaTool } from "../src/tools/execute";
import { registryFromCatalog, prepareTool } from "../src/tools/registry";
import { createApproval, decideApproval, deliverApproval, expireApproval, type ApprovalDriver } from "../src/approvals/store";
import { accountForUser, reserve, settleReservation } from "../src/credits/store";
import { ToolServiceError, type MagicaClient, type ProviderRun } from "../src/tools/magica-client";
import catalog from "./fixtures/magica-catalog.json";
vi.mock("server-only", () => ({}));
const db = getDatabase(), user = `approval_test_${randomUUID()}`;
const prepared = prepareTool(registryFromCatalog(catalog), "crop_image", { image_url: "https://example.com/source.png", crop: { x: 0, y: 0, width: 64, height: 64 } });
const driver: ApprovalDriver = { create: vi.fn(async id => `waitpoint_${id}`), wait: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
const client = (): MagicaClient => ({ catalog: vi.fn(), estimate: vi.fn().mockResolvedValue(5000), start: vi.fn().mockResolvedValue({ runId: "approved-receipt" }), read: vi.fn().mockResolvedValue({ id: "approved-receipt", nodeType: "crop_image", status: "COMPLETED", creditUsed: 4000, output: { image_url: "https://example.com/result.png" } } satisfies ProviderRun) });
async function fixture(balance = 10000) {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", String(balance));
  const { chat } = await createChat(user, { title: "Approval test" });
  const run = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Crop", model: "openrouter/free" });
  await db.agentRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });
  const tool = await registerInvocation(run.id, "approve", prepared);
  return { run, tool };
}
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.waitpoint.deleteMany({ where: { tool: { run: { user: { clerkUserId: user } } } } });
  await db.toolInvocation.deleteMany({ where: { run: { user: { clerkUserId: user } } } });
  await db.agentRun.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.user.deleteMany({ where: { clerkUserId: user } }); vi.clearAllMocks(); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());
it("persists a recoverable approval and hold before any provider submission; duplicate decisions submit and charge once", async () => {
  const { run, tool } = await fixture(), api = client();
  const approval = (await createApproval(tool.id, api))!;
  expect((await getOwnedRun(user, run.id)).assistantMessage.tools?.[0].approval).toMatchObject({ id: approval.id, status: "pending", estimate: 5000 });
  expect(await accountForUser(user)).toMatchObject({ available: 4000, reserved: 6000 });
  expect(api.start).not.toHaveBeenCalled();
  await Promise.all(Array.from({ length: 3 }, () => decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" })));
  await Promise.all(Array.from({ length: 2 }, () => executeMediaTool(tool.id, "child", async () => {}, new AbortController().signal, api, driver)));
  await executeMediaTool(tool.id, "duplicate", async () => {}, new AbortController().signal, api, driver);
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(await accountForUser(user)).toMatchObject({ balance: 6000, reserved: 1000 });
  expect(await db.creditLedger.count({ where: { kind: "settle", reservation: { toolId: tool.id } } })).toBe(1);
});
it.each(["rejected", "expired", "cancelled"] as const)("releases %s work and never submits it", async status => {
  const { run, tool } = await fixture(), api = client(), approval = (await createApproval(tool.id, api))!;
  if (status === "rejected") await decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: status });
  else if (status === "expired") await expireApproval(approval.id, new Date(approval.expiresAt.getTime() + 1));
  else await stopRun(user, run.id);
  await executeMediaTool(tool.id, "closed", async () => {}, new AbortController().signal, api, driver);
  expect(api.start).not.toHaveBeenCalled();
  expect(await accountForUser(user)).toMatchObject({ balance: 10000, reserved: status === "cancelled" ? 0 : 1000 });
  expect((await db.waitpoint.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe(status);
  await expect(decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" })).rejects.toMatchObject({ status: 409 });
});
it("enforces ownership and immutable settings, and rejects approval after stopping", async () => {
  const { run, tool } = await fixture(), approval = (await createApproval(tool.id, client()))!;
  const decision = { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" as const };
  await expect(decideApproval("other-user", approval.id, decision)).rejects.toMatchObject({ status: 404 });
  await expect(decideApproval(user, approval.id, { ...decision, inputHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  await stopRun(user, run.id);
  await expect(decideApproval(user, approval.id, decision)).rejects.toMatchObject({ status: 409 });
});
it("fails funding admission before a provider call, and never treats a missing approval driver as authorization", async () => {
  const { tool } = await fixture(2000), api = client();
  await expect(executeMediaTool(tool.id, "missing", async () => {}, new AbortController().signal, api)).rejects.toThrow("approval transport");
  const result = await executeMediaTool(tool.id, "unfunded", async () => {}, new AbortController().signal, api, driver);
  expect(result.ok).toBe(false); expect(api.start).not.toHaveBeenCalled();
  expect(await db.waitpoint.count({ where: { toolId: tool.id } })).toBe(0);
});
it("stores decisions before wakeup, retries failed delivery, and retains unknown-submission holds", async () => {
  const { tool } = await fixture(), api = client(), approval = (await createApproval(tool.id, api))!;
  await db.waitpoint.update({ where: { id: approval.id }, data: { tokenId: "waitpoint-test" } });
  await decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" });
  const complete = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(undefined);
  await deliverApproval(approval.id, complete);
  expect((await db.waitpoint.findUniqueOrThrow({ where: { id: approval.id } })).deliveredAt).toBeNull();
  await deliverApproval(approval.id, complete); await deliverApproval(approval.id, complete);
  expect(complete).toHaveBeenCalledTimes(2);
  vi.mocked(api.start).mockRejectedValue(new ToolServiceError("UNKNOWN", "Receipt missing"));
  await executeMediaTool(tool.id, "unknown", async () => {}, new AbortController().signal, api, driver);
  expect(await accountForUser(user)).toMatchObject({ balance: 10000, reserved: 6000 });
});

it("rechecks funding before submission when another completed job exceeds its estimate", async () => {
  const { run, tool } = await fixture(), api = client(), approval = (await createApproval(tool.id, api))!;
  await decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" });
  const owner = await db.user.findUniqueOrThrow({ where: { clerkUserId: user } });
  await db.$transaction(tx => reserve(tx, owner.id, run.id, "concurrent-cost", 2000));
  await db.$transaction(tx => settleReservation(tx, "concurrent-cost", 6000));
  const result = await executeMediaTool(tool.id, "funding-recheck", async () => {}, new AbortController().signal, api, driver);
  expect(result.ok).toBe(false); expect(api.start).not.toHaveBeenCalled();
  expect(await accountForUser(user)).toMatchObject({ balance: 4000, reserved: 1000 });
});

it("revalidates immutable input after the durable human wait", async () => {
  const { tool } = await fixture(), api = client();
  const tamperingDriver: ApprovalDriver = { ...driver, async wait() {
    const saved = await db.waitpoint.findUniqueOrThrow({ where: { toolId: tool.id } });
    await decideApproval(user, saved.id, { requestId: randomUUID(), inputHash: saved.inputHash, decision: "approved" });
    await db.toolInvocation.update({ where: { id: tool.id }, data: { input: { ...prepared.input, image_url: "https://example.com/changed.png" } } });
  } };
  await expect(executeMediaTool(tool.id, "changed-input", async () => {}, new AbortController().signal, api, tamperingDriver)).rejects.toThrow("Saved tool schema failed validation");
  expect(api.start).not.toHaveBeenCalled();
});

it("correlates deferred approval delivery with its saved token, tool, message and run", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { run, tool } = await fixture();
    const approval = (await createApproval(tool.id, client()))!;
    await db.waitpoint.update({ where: { id: approval.id }, data: { tokenId: "waitpoint-log-test" } });
    await decideApproval(user, approval.id, { requestId: randomUUID(), inputHash: approval.inputHash, decision: "approved" });
    await deliverApproval(approval.id, async () => { throw new Error("private-secret"); });
    expect(warn).toHaveBeenCalledWith("Approval wakeup deferred", expect.objectContaining({
      traceId: run.id, runId: run.id, chatId: run.chatId, messageId: run.assistantMessage.id,
      invocationId: tool.id, waitpointId: approval.id, waitpointTokenId: "waitpoint-log-test", processId: String(process.pid),
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-secret");
  } finally { warn.mockRestore(); }
});
