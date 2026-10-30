import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanSkills, skillPrompt, validateBundle } from "../src/skills/registry";
import { MAX_SKILL_FILE_BYTES, ReadSkillAssetInputSchema } from "../src/contracts/skills";
import { hashText } from "../src/lib/content-hash";

const temporary: string[] = [];
async function fixture(frontmatter = "name: sample\ndescription: Useful guidance", body = "Private guidance body.") {
  const root = await mkdtemp(join(tmpdir(), "magica-skill-")); temporary.push(root);
  await mkdir(join(root, "sample"));
  await writeFile(join(root, "sample/SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("discovers three representative skills while exposing only metadata in the base prompt", async () => {
  const registry = await scanSkills([resolve("agent-skills")]);
  expect([...registry.keys()].sort()).toEqual(["image-composition", "precise-cropping", "video-assembly"]);
  const prompt = skillPrompt(registry);
  for (const { bundle } of registry.values()) {
    expect(prompt).toContain(bundle.name); expect(prompt).toContain(bundle.description);
    expect(prompt).not.toContain(bundle.body); expect(prompt).not.toContain(bundle.assets[0].content);
  }
});
it("supports YAML block descriptions and hashes the complete immutable bundle", async () => {
  const root = await fixture("name: sample\ndescription: >-\n  Useful guidance\n  for tests");
  await writeFile(join(root, "sample/guide.md"), "Version one");
  const first = (await scanSkills([root])).get("sample")!;
  expect(first.bundle.description).toBe("Useful guidance for tests");
  await writeFile(join(root, "sample/guide.md"), "Version two");
  const second = (await scanSkills([root])).get("sample")!;
  expect(second.hash).not.toBe(first.hash);
  expect(first.bundle.assets[0].content).toBe("Version one");
  expect(hashText("Version one")).toHaveLength(64);
});
it.each([
  "name: sample", "name: sample\nname: sample\ndescription: Duplicate key", "name: [sample]\ndescription: Bad name",
  "name: sample\ndescription: !unknown Tagged", "name: sample\ndescription: true", "name: sample\ndescription: A\nextra: B",
  "name: sample\ndescription: &x [*x]", "name: ../sample\ndescription: Traversal", "name: mismatch\ndescription: Wrong folder",
])("rejects malformed or unsupported frontmatter: %s", async frontmatter => {
  const root = await fixture(frontmatter); await expect(scanSkills([root])).rejects.toThrow();
});
it("rejects missing frontmatter, duplicate names and oversized files", async () => {
  const a = await fixture(), b = await fixture();
  await expect(scanSkills([a, b])).rejects.toThrow("Duplicate skill name");
  await writeFile(join(a, "sample/SKILL.md"), "No header");
  await expect(scanSkills([a])).rejects.toThrow("frontmatter");
  await writeFile(join(b, "sample/guide.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1));
  await expect(scanSkills([b])).rejects.toThrow("size");
});
it("rejects unsupported formats, symlinked files, symlinked folders and invalid UTF-8", async () => {
  const roots = await Promise.all([fixture(), fixture(), fixture(), fixture()]);
  await writeFile(join(roots[0], "sample/tool.js"), "export default 1");
  await symlink(join(roots[1], "sample/SKILL.md"), join(roots[1], "sample/link.md"));
  await symlink(join(roots[2], "sample"), join(roots[2], "linked"));
  await writeFile(join(roots[3], "sample/binary.txt"), Buffer.from([0xff]));
  for (const root of roots) await expect(scanSkills([root])).rejects.toThrow();
});
it.each(["../secret.md", "/etc/passwd", "guides/../../secret.md", "guides\\secret.md", "%2e%2e/secret.md", "a//b.md", "a/./b.md", ".env", "tool.ts"])("rejects traversal or unsupported asset requests: %s", path => {
  expect(ReadSkillAssetInputSchema.safeParse({ name: "sample", path }).success).toBe(false);
});
it("validates persisted snapshots for duplicate paths, bounded bytes and text-only content", () => {
  const value = { formatVersion: 1, name: "sample", description: "Sample", body: "Guide", assets: [] };
  expect(() => validateBundle({ ...value, assets: [{ path: "a.md", content: "A" }, { path: "a.md", content: "B" }] })).toThrow();
  expect(() => validateBundle({ ...value, body: "界".repeat(6000) })).toThrow("text");
  expect(() => validateBundle({ ...value, body: "binary\u0000" })).toThrow("text");
});
