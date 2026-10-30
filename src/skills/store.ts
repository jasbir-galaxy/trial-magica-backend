import "server-only";
import { getDatabase } from "../db/client";
import { LoadSkillInputSchema, ReadSkillAssetInputSchema, MAX_SKILLS } from "../contracts/skills";
import { GuidanceOutputSchema } from "../contracts/tools";
import { hashJson, hashText } from "../lib/content-hash";
import { toolResult } from "../tools/store";
import { validateBundle, type SkillRegistry, type VersionedSkill } from "./registry";

function storedVersion(row: { contentHash: string; name: string; description: string; body: string; assets: unknown; formatVersion: number }): VersionedSkill {
  const version = validateBundle({ formatVersion: row.formatVersion, name: row.name, description: row.description, body: row.body, assets: row.assets });
  if (version.hash !== row.contentHash) throw new Error("Saved skill failed integrity validation.");
  return version;
}
export async function restoreRunSkills(runId: string, current: SkillRegistry): Promise<SkillRegistry> {
  const registry = new Map(current);
  const rows = await getDatabase().runSkill.findMany({ where: { runId }, take: MAX_SKILLS, include: { version: true } });
  for (const row of rows) registry.set(row.name, storedVersion(row.version));
  return registry;
}

export async function executeSkillTool(invocationId: string, registry: SkillRegistry, signal: AbortSignal) {
  const db = getDatabase();
  const found = await db.toolInvocation.findUniqueOrThrow({ where: { id: invocationId }, select: { runId: true } });
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${found.runId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ToolInvocation" WHERE id = ${invocationId}::uuid FOR UPDATE`;
    const row = await tx.toolInvocation.findUniqueOrThrow({ where: { id: invocationId }, include: { run: true } });
    if (!["load_skill", "read_skill_asset"].includes(row.name)) throw new Error("Not a skill loader invocation.");
    if (["completed", "failed", "cancelled"].includes(row.status)) return toolResult(row);
    const finish = async (status: "completed" | "failed" | "cancelled", error: string | null, output?: ReturnType<typeof GuidanceOutputSchema.parse>) => toolResult(await tx.toolInvocation.update({
      where: { id: row.id }, data: { status, error, ...(output ? { output } : {}), credits: 0, startedAt: row.createdAt, finishedAt: new Date(), durationMs: Math.max(0, Date.now() - row.createdAt.getTime()) },
    }));
    if (signal.aborted || row.run.status !== "running") return finish("cancelled", "This reply stopped before the guidance was loaded.");
    const schema = row.name === "load_skill" ? LoadSkillInputSchema : ReadSkillAssetInputSchema;
    const parsed = schema.safeParse(row.input);
    if (!parsed.success || hashJson(row.inputSchema) !== row.schemaHash || hashJson({ name: row.name, input: row.input }) !== row.inputHash || row.subModelId) return finish("failed", "The saved guidance request is invalid. Send a new message to continue.");
    const input = parsed.data;
    const pinned = await tx.runSkill.findUnique({ where: { runId_name: { runId: row.runId, name: input.name } }, include: { version: true } });
    let version = pinned ? storedVersion(pinned.version) : undefined;
    if (!version) {
      if (row.name !== "load_skill") return finish("failed", "Load this skill before reading its assets.");
      version = registry.get(input.name);
      if (!version) return finish("failed", "This skill is unavailable. Choose a skill from the available list.");
      version = validateBundle(version.bundle);
      const { bundle, hash } = version;
      // Content-addressed versions are immutable. The run pins one version per
      // name, including assets not yet requested, before returning any guidance.
      await tx.skillVersion.upsert({ where: { contentHash: hash }, update: {}, create: { contentHash: hash, ...bundle } });
      await tx.runSkill.create({ data: { runId: row.runId, name: bundle.name, versionHash: hash } });
    }
    const path = row.name === "load_skill" ? "SKILL.md" : ReadSkillAssetInputSchema.parse(input).path;
    const text = path === "SKILL.md" ? version.bundle.body : version.bundle.assets.find(asset => asset.path === path)?.content;
    if (!text) return finish("failed", "This asset is not available in the loaded skill. Use a listed asset path.");
    return finish("completed", null, GuidanceOutputSchema.parse({ assets: [], credits: 0, text, skill: {
      name: input.name, path, versionHash: version.hash, contentHash: hashText(text), assets: version.bundle.assets.map(asset => asset.path),
    } }));
  });
}
