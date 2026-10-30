import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat, listMessages } from "../src/chats/service";
import { createTurn, contextForRun, getOwnedRun, stopRun } from "../src/agent/run-store";
import { executeTurn } from "../src/agent/execute-turn";
import { prepareTool, registryFromCatalog } from "../src/tools/registry";
import { registerInvocation } from "../src/tools/store";
import { getSkillRegistry, validateBundle } from "../src/skills/registry";
import { withSkillTools } from "../src/skills/tools";
import { executeSkillTool, restoreRunSkills } from "../src/skills/store";
import type { TextModel } from "../src/agent/model";
import catalog from "./fixtures/magica-catalog.json";
vi.mock("server-only", () => ({}));
const db = getDatabase(), user = `skill_test_${randomUUID()}`;
const signal = () => new AbortController().signal;
const name = "precise-cropping";
async function fixture(running = true) {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "1000000");
  const { chat } = await createChat(user, { title: "Skill fixture" });
  const run = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Plan a centered crop", model: "openrouter/free" });
  if (running) await db.agentRun.update({ where: { id: run.id }, data: { status: "running" } });
  const skills = await getSkillRegistry(), registry = withSkillTools(new Map(), skills, signal());
  return { chat, run, skills, registry };
}
afterEach(async () => {
  await db.creditLedger.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditReservation.deleteMany({ where: { account: { user: { clerkUserId: user } } } });
  await db.creditAccount.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.waitpoint.deleteMany({ where: { tool: { run: { user: { clerkUserId: user } } } } });
  await db.toolInvocation.deleteMany({ where: { run: { user: { clerkUserId: user } } } });
  await db.runSkill.deleteMany({ where: { run: { user: { clerkUserId: user } } } });
  await db.skillVersion.deleteMany({ where: { runs: { none: {} } } });
  await db.agentRun.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.message.deleteMany({ where: { chat: { user: { clerkUserId: user } } } });
  await db.chat.deleteMany({ where: { user: { clerkUserId: user } } });
  await db.user.deleteMany({ where: { clerkUserId: user } });
});
afterAll(async () => db.$disconnect());

it("deduplicates concurrent loads and pins unrequested assets across changed or removed files", async () => {
  const { run, skills, registry } = await fixture();
  const prepared = prepareTool(registry, "load_skill", { name });
  const rows = await Promise.all(["a", "b"].map(call => registerInvocation(run.id, call, prepared)));
  expect(rows[0].id).toBe(rows[1].id);
  const results = await Promise.all(rows.map(row => executeSkillTool(row.id, skills, signal())));
  expect(results[0]).toEqual(results[1]);
  expect(await db.runSkill.count({ where: { runId: run.id } })).toBe(1);
  expect(await db.creditReservation.count({ where: { runId: run.id } })).toBe(1); // admission only
  const original = skills.get(name)!;
  const changed = new Map(skills);
  changed.set(name, validateBundle({ ...original.bundle, body: "Changed guidance", assets: [{ path: "guides/rectangles.md", content: "Changed asset" }] }));
  const restored = await restoreRunSkills(run.id, changed);
  expect(restored.get(name)).toEqual(original);
  expect((await restoreRunSkills(run.id, new Map())).get(name)).toEqual(original);
  const asset = await registerInvocation(run.id, "asset", prepareTool(registry, "read_skill_asset", { name, path: "guides/rectangles.md" }));
  const result = await executeSkillTool(asset.id, changed, signal());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.output).toMatchObject({ text: original.bundle.assets[0].content, skill: { versionHash: original.hash } });
  expect((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).applicationCredits).toBe(BigInt(0));
});
it("requires explicit loading and rejects unknown names and traversal before admission", async () => {
  const { run, registry, skills } = await fixture();
  expect(() => prepareTool(registry, "load_skill", { name: "unknown" })).toThrow();
  expect(() => prepareTool(registry, "read_skill_asset", { name, path: "../secret.md" })).toThrow();
  const asset = await registerInvocation(run.id, "too-early", prepareTool(registry, "read_skill_asset", { name, path: "guides/rectangles.md" }));
  expect(await executeSkillTool(asset.id, skills, signal())).toMatchObject({ ok: false, error: "Load this skill before reading its assets." });
  expect(await db.runSkill.count({ where: { runId: run.id } })).toBe(0);
});
it("checks cancellation and detects altered saved requests and corrupted snapshots", async () => {
  const a = await fixture(), stopped = await registerInvocation(a.run.id, "stop", prepareTool(a.registry, "load_skill", { name }));
  await stopRun(user, a.run.id);
  expect(await executeSkillTool(stopped.id, a.skills, signal())).toMatchObject({ ok: false });
  expect(await db.runSkill.count({ where: { runId: a.run.id } })).toBe(0);
  const b = await fixture(), changed = await registerInvocation(b.run.id, "changed", prepareTool(b.registry, "load_skill", { name }));
  await db.toolInvocation.update({ where: { id: changed.id }, data: { input: { name: "image-composition" } } });
  expect(await executeSkillTool(changed.id, b.skills, signal())).toMatchObject({ ok: false });
  const good = await registerInvocation(b.run.id, "good", prepareTool(b.registry, "load_skill", { name: "image-composition" }));
  await executeSkillTool(good.id, b.skills, signal());
  const pin = await db.runSkill.findFirstOrThrow({ where: { runId: b.run.id } });
  await db.skillVersion.update({ where: { contentHash: pin.versionHash }, data: { body: "Corrupt" } });
  await expect(restoreRunSkills(b.run.id, b.skills)).rejects.toThrow("integrity");
});
it("loads only the relevant skill through the model loop, persists generic cards and excludes bodies from future history", async () => {
  const { chat, run, skills } = await fixture(false); let step = 0;
  const original = skills.get(name)!;
  const media = vi.fn();
  const model: TextModel = { async *stream(messages, _signal, tools) {
    expect(tools?.map(tool => tool.name)).toContain("load_skill");
    expect(messages[0].content).not.toContain(original.bundle.body);
    if (++step === 1) yield { type: "tool_calls", calls: [{ id: "load", name: "load_skill", arguments: JSON.stringify({ name }) }] };
    else if (step === 2) {
      expect(messages.at(-1)!.content).toContain("Precise cropping");
      yield { type: "tool_calls", calls: [{ id: "asset", name: "read_skill_asset", arguments: JSON.stringify({ name, path: "guides/rectangles.md" }) }] };
    } else yield { type: "text", text: "Use x=160, y=120, width=320, height=240. No image was generated." };
  } };
  await executeTurn(run.id, `run_${randomUUID()}`, model, signal(), vi.fn(), vi.fn(), media, new Map(), skills);
  expect(media).not.toHaveBeenCalled();
  expect(await db.runSkill.count({ where: { runId: run.id } })).toBe(1);
  const saved = await getOwnedRun(user, run.id);
  expect(saved.status).toBe("completed"); expect(saved.assistantMessage.tools?.map(tool => tool.name)).toEqual(["load_skill", "read_skill_asset"]);
  const history = await listMessages(user, chat.id, { limit: 2, order: "desc" });
  expect(history.items[0].tools[0].output).toMatchObject({ text: original.bundle.body });
  await expect(getOwnedRun("another-owner", run.id)).rejects.toMatchObject({ status: 404 });
  const next = await createTurn(user, chat.id, { requestId: randomUUID(), text: "Hello", model: "openrouter/free" });
  const context = JSON.stringify(await contextForRun(next.id));
  expect(context).not.toContain(original.bundle.body); expect(context).not.toContain(original.bundle.assets[0].content);
  expect(context).toContain("loadedSkill");
});
it("executes mixed batches deterministically and keeps media behind the ordinary executor", async () => {
  const { run, skills } = await fixture(false); let step = 0;
  const media = vi.fn(async (ids: string[]) => ids.map(id => ({ ok: false as const, invocationId: id, error: "Media approval required.", retryable: false })));
  const model: TextModel = { async *stream() {
    if (++step === 1) yield { type: "tool_calls", calls: [
      { id: "load", name: "load_skill", arguments: JSON.stringify({ name }) },
      { id: "asset", name: "read_skill_asset", arguments: JSON.stringify({ name, path: "guides/rectangles.md" }) },
      { id: "crop", name: "crop_image", arguments: JSON.stringify({ image_url: "https://example.com/image.png", crop: { x: 0, y: 0, width: 64, height: 64 } }) },
    ] };
  } };
  await expect(executeTurn(run.id, `run_${randomUUID()}`, model, signal(), vi.fn(), vi.fn(), media, registryFromCatalog(catalog), skills)).rejects.toThrow("Media approval required");
  const rows = await db.toolInvocation.findMany({ where: { runId: run.id }, orderBy: { position: "asc" } });
  expect(rows.map(row => row.name)).toEqual(["load_skill", "read_skill_asset", "crop_image"]);
  expect(rows.slice(0, 2).every(row => row.status === "completed")).toBe(true);
  expect(media).toHaveBeenCalledWith([rows[2].id]);
});
