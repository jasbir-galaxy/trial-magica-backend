import { hashJson } from "../lib/content-hash";
export { hashJson } from "../lib/content-hash";
import { z } from "zod";
import { MediaUrlSchema, MediaOutputSchema, MediaToolNameSchema, MAX_TOOL_INPUT_BYTES, type ToolName, type MediaToolName, type ToolOutput, type ToolResult } from "../contracts/tools";
import { createMagicaClient, mediaConfigured, type ProviderRun } from "./magica-client";
import type { ModelTool } from "../agent/model";

const rectangle = { x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() };
export const CropInput = z.union([
  z.strictObject({ image_url: MediaUrlSchema, crop: z.strictObject(rectangle) }),
  z.strictObject({ image_url: MediaUrlSchema, x_px: rectangle.x, y_px: rectangle.y, width_px: rectangle.width, height_px: rectangle.height }),
  z.strictObject({ image_url: MediaUrlSchema, x_percent: z.number().min(0).max(100), y_percent: z.number().min(0).max(100), width_percent: z.number().positive().max(100), height_percent: z.number().positive().max(100) })
    .refine(v => v.x_percent + v.width_percent <= 100 && v.y_percent + v.height_percent <= 100, "The rectangle must fit within the image."),
]);
export const MergeInput = z.strictObject({ video_urls: z.array(MediaUrlSchema).min(2).max(100), transition: z.enum(["none", "fade", "dissolve"]).default("none") });
const Field = z.object({ zodExpectedName: z.string(), description: z.string().optional(), options: z.array(z.object({ value: z.union([z.string(), z.number(), z.boolean()]) })).optional() });
const Catalog = z.object({ version: z.literal(1), models: z.record(z.string(), z.object({ nodeType: z.string(), subModels: z.array(z.object({ subModelId: z.string(), inputSchema: z.record(z.string(), z.json()), inputFieldOptions: z.array(Field).optional() })) })) });
export type PreparedTool = { name: ToolName; label: string; input: Record<string, z.core.util.JSONType>; subModelId?: string; inputSchema: Record<string, z.core.util.JSONType>; schemaHash: string; inputHash: string };
export type RegisteredTool = { planSafe?: boolean; name: ToolName; label: string; description: string; schema: z.ZodType; modelInput?: { schema: z.ZodType; jsonSchema: Record<string, z.core.util.JSONType> }; jsonSchema: Record<string, z.core.util.JSONType>; execute?: (ids: string[]) => Promise<ToolResult[]> };
export type ToolRegistry = ReadonlyMap<string, RegisteredTool>;
const jsonObject = (v: unknown) => z.record(z.string(), z.json()).parse(v);
function entry(name: ToolName, label: string, description: string, schema: z.ZodType, jsonSchema = jsonObject(z.toJSONSchema(schema, { unrepresentable: "any" }))) { return { name, label, description, schema, jsonSchema }; }

export function registryFromCatalog(value: unknown): ToolRegistry {
  const catalog = Catalog.parse(value);
  const model = Object.values(catalog.models).find(m => m.nodeType === "gpt_image_2");
  const definitions: Record<string, unknown> = {};
  const variants = ["gpt-image-2-text", "gpt-image-2-edit"].map((id, index) => {
    const sub = model?.subModels.find(s => s.subModelId === id);
    if (!sub) throw new Error("Required image model is unavailable");
    const schema = structuredClone(sub.inputSchema) as Record<string, unknown>;
    const props = jsonObject(schema.properties);
    // Catalog schemas contain permissive preprocessors. The same catalog's field
    // options supply their current choices; never hard-code provider field enums.
    delete props.processId;
    for (const field of sub.inputFieldOptions ?? []) {
      if (!(field.zodExpectedName in props)) continue;
      const prop = jsonObject(props[field.zodExpectedName]);
      if (field.options?.length && field.zodExpectedName !== "size") {
        props[field.zodExpectedName] = { ...prop, enum: field.options.map(o => o.value), ...(field.description ? { description: field.description.slice(0, 2000) } : {}) };
      } else if (field.description) props[field.zodExpectedName] = { ...prop, description: field.description.slice(0, 2000) };
    }
    schema.properties = props; schema.additionalProperties = false;
    // Draft-7 definitions must live at the root of the composed tool schema.
    const scoped = JSON.parse(JSON.stringify(schema).replaceAll("#/definitions/", `#/definitions/v${index}_`)) as Record<string, unknown>;
    for (const [key, value] of Object.entries((scoped.definitions ?? {}) as Record<string, unknown>)) definitions[`v${index}_${key}`] = value;
    delete scoped.definitions;
    return { type: "object", properties: { subModelId: { type: "string", const: id }, input: scoped }, required: ["subModelId", "input"], additionalProperties: false };
  });
  const imageJson = jsonObject({ type: "object", anyOf: variants, definitions });
  // Keep the API's optional defaults compatible. Only agent-originated calls
  // must explicitly choose settings before the approval/dispatch boundary.
  const modelVariants = structuredClone(variants);
  for (const variant of modelVariants) {
    const input = variant.properties.input;
    const properties = jsonObject(input.properties);
    const required = new Set(z.array(z.string()).parse(input.required ?? []));
    for (const key of ["size", "quality"]) {
      if (!(key in properties)) continue;
      const property = jsonObject(properties[key]);
      delete property.default; // Zod defaults would otherwise fill a missing explicit choice.
      properties[key] = property; required.add(key);
    }
    input.properties = properties; input.required = [...required];
  }
  // Some routed models miss fields exposed only inside a root union. The root
  // envelope and the per-submodel constraints describe the same arguments.
  const modelImageJson = jsonObject({ type: "object", properties: {
    subModelId: { type: "string", enum: variants.map(v => v.properties.subModelId.const) },
    input: { type: "object", description: "Put the prompt and all selected generation settings here. Explicitly set size and quality from this variant's catalog fields." },
  }, required: ["subModelId", "input"], anyOf: modelVariants, definitions });
  const validateImage = (json: Record<string, z.core.util.JSONType>) => z.fromJSONSchema(json, { defaultTarget: "draft-7" }).superRefine((v, ctx) => {
    // Validate media URL fields from the catalog without permitting private URLs.
    const check = (value: unknown, key = "") => {
      if (typeof value === "string" && /url|mask|uploadedImages/i.test(key) && !MediaUrlSchema.safeParse(value).success) ctx.addIssue({ code: "custom", message: "Use a public HTTPS media URL." });
      else if (Array.isArray(value)) value.forEach(item => check(item, key));
      else if (value && typeof value === "object") Object.entries(value).forEach(([k, item]) => check(item, k));
    }; check(v);
  });
  const imageSchema = validateImage(imageJson);
  const tools: RegisteredTool[] = [
    entry("crop_image", "Crop Image", "Crop an existing image URL. Preserve the requested units: crop and *_px use pixels; *_percent use percentages. A percentage request should use all four *_percent fields. Supply exactly one complete rectangle: crop in pixels, x_px/y_px/width_px/height_px, or x_percent/y_percent/width_percent/height_percent. Use URLs from previous tool results when chaining.", CropInput),
    { ...entry("gpt_image_2", "GPT Image 2", "Create an image with gpt-image-2-text, or modify supplied images with gpt-image-2-edit. Arguments must contain exactly subModelId and input. Put all generation settings, including prompt, inside the nested input object, never at the top level. The input fields are from the current model catalog. Use the edit variant when an input image is provided. Use one image unless more are requested. Explicitly select size and quality from the catalog, matching the request; a size written only in the prompt does not set the output size.", imageSchema, imageJson), modelInput: { schema: validateImage(modelImageJson), jsonSchema: modelImageJson } },
    entry("merge_videos", "Merge Videos", "Join 2–100 videos in the supplied order. Use none, fade or dissolve transitions. Ask for missing video URLs; never invent input assets.", MergeInput),
  ];
  const cropTool = tools.find(tool => tool.name === "crop_image")!;
  const cropVariants = z.array(z.record(z.string(), z.json())).parse(cropTool.jsonSchema.anyOf);
  const cropProperties = Object.assign({}, ...cropVariants.map(variant => jsonObject(variant.properties)));
  // Preserve all three rectangle contracts, but make their fields visible to
  // models that inspect only root properties when constructing arguments.
  cropTool.modelInput = { schema: CropInput, jsonSchema: {
    ...cropTool.jsonSchema, properties: cropProperties, required: ["image_url"],
  } };
  return new Map(tools.map(tool => [tool.name, tool]));
}
let cached: { base: string; expires: number; promise: Promise<ToolRegistry> } | undefined;
export async function loadToolRegistry(): Promise<ToolRegistry> {
  if (!mediaConfigured()) return new Map();
  const base = process.env.MAGICA_API_BASE_URL!;
  if (!cached || cached.base !== base || cached.expires < Date.now()) {
    cached = { base, expires: Date.now() + 300_000, promise: createMagicaClient().catalog().then(registryFromCatalog) };
    cached.promise.catch(() => { cached = undefined; });
  }
  return cached.promise;
}
export function modelTools(registry: ToolRegistry): ModelTool[] { return [...registry.values()].map(t => ({ name: t.name, description: t.description, parameters: t.modelInput?.jsonSchema ?? t.jsonSchema })); }
export class ToolInputError extends Error {
  constructor(message: string, readonly fields: string[] = []) { super(message); this.name = "ToolInputError"; }
}
function issueWeight(issue: z.core.$ZodIssue): number {
  return issue.code === "unrecognized_keys" ? issue.keys.length * 2 : 1;
}
function invalidFields(issues: z.core.$ZodIssue[]): string[] {
  return issues.flatMap(issue => {
    if (issue.code === "invalid_union") return invalidFields([...issue.errors].sort((a, b) => a.reduce((n, i) => n + issueWeight(i), 0) - b.reduce((n, i) => n + issueWeight(i), 0))[0] ?? []);
    const paths = issue.code === "unrecognized_keys" ? issue.keys : [issue.path.join(".") || "input"];
    return paths.slice(0, 4).map(path => `${String(path).replace(/[^a-zA-Z0-9_.]/g, "?").slice(0, 50)} (${issue.code})`);
  }).slice(0, 4);
}
export function prepareTool(registry: ToolRegistry, name: string, raw: unknown, options: { forModel?: boolean } = {}): PreparedTool {
  const tool = registry.get(name); if (!tool) throw new ToolInputError("This tool is unavailable. Choose a tool from the provided list.");
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_TOOL_INPUT_BYTES) throw new ToolInputError("Tool input is too large. Reduce it to fit the tool schema.");
  const contract = options.forModel && tool.modelInput ? tool.modelInput : tool;
  const result = contract.schema.safeParse(raw);
  if (!result.success) {
    const fields = invalidFields(result.error.issues);
    throw new ToolInputError(`${tool.label} inputs need correction: ${fields.join(", ")}. Follow the tool schema.`.slice(0, 300), fields);
  }
  const data = jsonObject(result.data), subModelId = typeof data.subModelId === "string" ? data.subModelId : undefined;
  const input = subModelId ? jsonObject(data.input) : data;
  return { name: tool.name, label: tool.label, input, ...(subModelId ? { subModelId } : {}), inputSchema: contract.jsonSchema, schemaHash: hashJson(contract.jsonSchema), inputHash: hashJson({ name, subModelId, input }) };
}
export function normalizeOutput(name: MediaToolName, run: ProviderRun): ToolOutput {
  MediaToolNameSchema.parse(name);
  if (run.status !== "COMPLETED" || run.nodeType !== name) throw new Error("Invalid tool result");
  const output = z.object({ image_url: MediaUrlSchema.optional(), video_url: MediaUrlSchema.optional(), result: z.array(MediaUrlSchema).max(100).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).parse(run.output);
  const urls = name === "gpt_image_2" ? output.result : name === "crop_image" ? [output.image_url] : [output.video_url];
  return MediaOutputSchema.parse({ credits: run.creditUsed, assets: urls?.map(url => ({ kind: name === "merge_videos" ? "video" : "image", url, width: output.width, height: output.height })) });
}
