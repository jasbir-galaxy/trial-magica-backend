import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { hashJson } from "../lib/content-hash";
import { MAX_SKILLS, MAX_SKILL_ASSETS, MAX_SKILL_FILE_BYTES, MAX_SKILL_BUNDLE_BYTES, SkillAssetPathSchema, SkillBundleSchema, SkillMetadataSchema, SKILL_POLICY, type SkillBundle } from "../contracts/skills";

export type VersionedSkill = { hash: string; bundle: SkillBundle };
export type SkillRegistry = ReadonlyMap<string, VersionedSkill>;
const MAX_FRONTMATTER_BYTES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function validateBundle(value: unknown): VersionedSkill {
  const bundle = SkillBundleSchema.parse(value);
  for (const content of [bundle.body, ...bundle.assets.map(asset => asset.content)]) {
    if (Buffer.byteLength(content) > MAX_SKILL_FILE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error("Invalid skill text.");
  }
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_SKILL_BUNDLE_BYTES) throw new Error("Skill bundle exceeds its size limit.");
  return { hash: hashJson(bundle), bundle };
}

// Only the application passes approved roots. Model inputs are never filesystem paths.
export async function scanSkills(roots: readonly string[]): Promise<SkillRegistry> {
  const registry = new Map<string, VersionedSkill>();
  for (const configured of roots) {
    if (!(await lstat(configured)).isDirectory()) throw new Error("Skill root must be a real directory.");
    const root = await realpath(configured);
    const directories = await opendir(root);
    for await (const entry of directories) {
      if (!entry.isDirectory()) throw new Error("Skill roots may contain only skill directories.");
      if (registry.size >= MAX_SKILLS) throw new Error("Skill registry exceeds its size limit.");
      const folder = join(root, entry.name), files = new Map<string, string>();
      let totalBytes = 0, entries = 0;
      async function walk(directory: string, depth: number) {
        if (depth > 3) throw new Error("Skill directory is too deep.");
        for await (const file of await opendir(directory)) {
          if (++entries > 32) throw new Error("Skill directory has too many entries.");
          const absolute = join(directory, file.name);
          if (file.isDirectory()) { await walk(absolute, depth + 1); continue; }
          if (!file.isFile()) throw new Error("Skill links and special files are not supported.");
          const path = relative(folder, absolute).split(sep).join("/");
          if (path !== "SKILL.md") SkillAssetPathSchema.parse(path);
          if (files.size > MAX_SKILL_ASSETS) throw new Error("Skill has too many files.");
          const canonical = await realpath(absolute);
          if (!canonical.startsWith(folder + sep)) throw new Error("Skill path escapes its directory.");
          const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SKILL_FILE_BYTES) throw new Error("Invalid skill file size or type.");
            // A bounded read also protects against a file growing after stat().
            const bytes = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
            let length = 0;
            while (length < bytes.length) {
              const read = await handle.read(bytes, length, bytes.length - length, length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length > MAX_SKILL_FILE_BYTES) throw new Error("Skill file exceeds its size limit.");
            totalBytes += length;
            if (totalBytes > MAX_SKILL_BUNDLE_BYTES) throw new Error("Skill bundle exceeds its size limit.");
            files.set(path, decoder.decode(bytes.subarray(0, length)));
          } finally { await handle.close(); }
        }
      }
      await walk(folder, 0);
      const source = files.get("SKILL.md")?.replaceAll("\r\n", "\n");
      const match = source?.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
      if (!match || Buffer.byteLength(match[1]) > MAX_FRONTMATTER_BYTES) throw new Error("Skill requires bounded YAML frontmatter.");
      const document = parseDocument(match[1], { uniqueKeys: true, strict: true, schema: "core", prettyErrors: false });
      if (document.errors.length || document.warnings.length) throw new Error("Invalid skill frontmatter.");
      const metadata = SkillMetadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
      if (registry.has(metadata.name)) throw new Error("Duplicate skill name.");
      if (metadata.name !== entry.name) throw new Error("Skill name must match its directory.");
      const skill = validateBundle({ formatVersion: 1, ...metadata, body: match[2].trim(), assets: [...files].filter(([path]) => path !== "SKILL.md").sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content })) });
      registry.set(metadata.name, skill);
    }
  }
  return registry;
}

let cached: Promise<SkillRegistry> | undefined;
export function getSkillRegistry(): Promise<SkillRegistry> {
  return cached ??= scanSkills([resolve(process.cwd(), "agent-skills")]);
}
export function skillPrompt(registry: SkillRegistry): string {
  return SKILL_POLICY + JSON.stringify([...registry.values()].map(({ bundle }) => SkillMetadataSchema.parse({ name: bundle.name, description: bundle.description })));
}
