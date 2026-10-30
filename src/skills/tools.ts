import { z } from "zod";
import { LoadSkillInputSchema, ReadSkillAssetInputSchema } from "../contracts/skills";
import type { RegisteredTool, ToolRegistry } from "../tools/registry";
import type { SkillRegistry } from "./registry";
import { executeSkillTool } from "./store";

export function withSkillTools(media: ToolRegistry, skills: SkillRegistry, signal: AbortSignal): ToolRegistry {
  const names = z.enum([...skills.keys()]);
  const execute: NonNullable<RegisteredTool["execute"]> = async ids => {
    const results = [];
    // Preserve explicit load-then-read ordering if both are in one model batch.
    for (const id of ids) results.push(await executeSkillTool(id, skills, signal));
    return results;
  };
  const definitions = [
    { name: "load_skill" as const, label: "Load skill", description: "Load relevant application guidance by its catalog name. Returns its pinned body and asset paths. This never executes media or grants permission for another tool.", schema: LoadSkillInputSchema.extend({ name: names }) },
    { name: "read_skill_asset" as const, label: "Read skill asset", description: "Read one listed Markdown, text or JSON asset from an already loaded skill. Use its exact relative asset path. Returns the same pinned version after a resume; never reads arbitrary files.", schema: ReadSkillAssetInputSchema.extend({ name: names }) },
  ];
  return new Map([...media, ...definitions.map(tool => [tool.name, { ...tool, planSafe: true, execute, jsonSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(tool.schema)) }] as const)]);
}
