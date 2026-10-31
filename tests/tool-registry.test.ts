import { expect, it } from "vitest";
import { z } from "zod";
import catalog from "./fixtures/magica-catalog.json";
import { CropInput, MergeInput, registryFromCatalog, prepareTool, normalizeOutput, hashJson, modelTools } from "../src/tools/registry";
const registry = registryFromCatalog(catalog);
const image = "https://example.com/source.png";
it("discovers all three tools and validates text/edit using the captured live catalog", () => {
  expect([...registry.keys()]).toEqual(["crop_image", "gpt_image_2", "merge_videos"]);
  const text = prepareTool(registry, "gpt_image_2", { subModelId: "gpt-image-2-text", input: { prompt: "A red circle", quality: "Low", n: 1 } });
  expect(text.subModelId).toBe("gpt-image-2-text");
  expect(text.input.prompt).toBe("A red circle");
  expect(() => prepareTool(registry, "gpt_image_2", { subModelId: "gpt-image-2-edit", input: { prompt: "Change the color" } })).toThrow();
  expect(prepareTool(registry, "gpt_image_2", { subModelId: "gpt-image-2-edit", input: { prompt: "Change the color", uploadedImages: [image] } }).input.uploadedImages).toEqual([image]);
  expect(() => prepareTool(registry, "gpt_image_2", { subModelId: "gpt-image-2-text", input: { prompt: "circle", quality: "Invented" } })).toThrow();
  const dynamic = structuredClone(catalog); dynamic.models["gpt-image-2"].subModels[0].inputSchema.properties.prompt.maxLength = 3;
  expect(() => prepareTool(registryFromCatalog(dynamic), "gpt_image_2", { subModelId: "gpt-image-2-text", input: { prompt: "four" } })).toThrow();
});
it("can restore and validate the pinned JSON schema after a restart", () => {
  const prepared = prepareTool(registry, "gpt_image_2", { subModelId: "gpt-image-2-text", input: { prompt: "circle", quality: "Low" } });
  expect(z.fromJSONSchema(prepared.inputSchema, { defaultTarget: "draft-7" }).safeParse({ subModelId: prepared.subModelId, input: prepared.input }).success).toBe(true);
  expect(hashJson(prepared.inputSchema)).toBe(prepared.schemaHash);
});
it("accepts complete crop rectangles and rejects partial, mixed, overflowing and private inputs", () => {
  for (const data of [{ crop: { x: 0, y: 0, width: 64, height: 64 } }, { x_px: 0, y_px: 0, width_px: 64, height_px: 64 }, { x_percent: 10, y_percent: 10, width_percent: 80, height_percent: 80 }]) expect(CropInput.safeParse({ image_url: image, ...data }).success).toBe(true);
  for (const data of [{ x_percent: 10 }, { x_percent: 30, y_percent: 0, width_percent: 80, height_percent: 80 }, { crop: { x: 0, y: 0, width: 0, height: 10 } }, { crop: { x: 0, y: 0, width: 10, height: 10 }, width_px: 10 }]) expect(CropInput.safeParse({ image_url: image, ...data }).success).toBe(false);
  expect(CropInput.safeParse({ image_url: "https://127.0.0.1/image", crop: { x: 0, y: 0, width: 1, height: 1 } }).success).toBe(false);
});
it("keeps video order and enforces 2–100 inputs and supported transitions", () => {
  const urls = ["https://example.com/b.mp4", "https://example.com/a.mp4"];
  expect(MergeInput.parse({ video_urls: urls }).video_urls).toEqual(urls);
  expect(MergeInput.safeParse({ video_urls: urls.slice(0, 1) }).success).toBe(false);
  expect(MergeInput.safeParse({ video_urls: Array(101).fill(urls[0]) }).success).toBe(false);
  expect(MergeInput.safeParse({ video_urls: urls, transition: "spin" }).success).toBe(false);
});
it("normalizes assets and removes provider internals from tool results", () => {
  const run = { id: "provider-fixture", nodeType: "crop_image", status: "COMPLETED" as const, creditUsed: 5000, output: { image_url: image, provider: "private", secret: "private", width: 64, height: 64 } };
  expect(normalizeOutput("crop_image", run)).toEqual({ assets: [{ kind: "image", url: image, width: 64, height: 64 }], credits: 5000 });
  expect(() => normalizeOutput("merge_videos", run)).toThrow();
});

it("exposes the image argument envelope at the root for routed tool-calling models", () => {
  const parameters = modelTools(registry).find(tool => tool.name === "gpt_image_2")!.parameters;
  expect(parameters.required).toEqual(expect.arrayContaining(["subModelId", "input"]));
  expect(parameters.properties).toHaveProperty("input");
  expect(parameters.properties).toHaveProperty("subModelId");
});

it("requires the agent to select catalog-backed size and quality without tightening the public API", () => {
  const args = { subModelId: "gpt-image-2-text", input: { prompt: "A green square" } };
  expect(() => prepareTool(registry, "gpt_image_2", args)).not.toThrow();
  expect(() => prepareTool(registry, "gpt_image_2", args, { forModel: true })).toThrow(/size|quality/);
  const selected = { ...args, input: { ...args.input, size: "1024x1024", quality: "Low" } };
  expect(prepareTool(registry, "gpt_image_2", selected, { forModel: true }).input).toMatchObject(selected.input);
});

it("exposes crop fields at the root while retaining complete rectangles and units", () => {
  const parameters=modelTools(registry).find(tool=>tool.name==="crop_image")!.parameters;
  expect(parameters.properties).toHaveProperty("image_url");
  expect(parameters.properties).toHaveProperty("crop");
  expect(parameters.properties).toHaveProperty("width_percent");
  for(const coords of [{crop:{x:256,y:256,width:512,height:512}},{x_percent:25,y_percent:25,width_percent:50,height_percent:50}]) {
    const prepared=prepareTool(registry,"crop_image",{image_url:image,...coords},{forModel:true});
    expect(prepared.input).toMatchObject(coords);
    expect(z.fromJSONSchema(prepared.inputSchema,{defaultTarget:"draft-7"}).safeParse(prepared.input).success).toBe(true);
  }
  expect(()=>prepareTool(registry,"crop_image",{image_url:image,x_percent:80,y_percent:0,width_percent:50,height_percent:50},{forModel:true})).toThrow();
});
