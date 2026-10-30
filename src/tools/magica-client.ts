import { z } from "zod";
import type { MediaToolName } from "../contracts/tools";

const Environment = z.object({ MAGICA_API_KEY: z.string().min(1).regex(/^\S+$/), MAGICA_API_BASE_URL: z.url().refine(v => {
  const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
}) });
const Receipt = z.object({ runId: z.string().min(1).max(200) });
export const ProviderRunSchema = z.object({
  id: z.string().min(1).max(200), nodeType: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELED"]),
  creditUsed: z.number().int().nonnegative().max(2_147_483_647), output: z.unknown().nullable(),
});
export type ProviderRun = z.infer<typeof ProviderRunSchema>;
export class ToolServiceError extends Error {
  constructor(readonly code: "CONFIGURATION" | "AUTH" | "RATE_LIMIT" | "REJECTED" | "UNAVAILABLE" | "UNKNOWN" | "INVALID_RESULT", message: string) { super(message); this.name = "ToolServiceError"; }
}
export function mediaConfigured() { return Environment.safeParse(process.env).success; }
export async function boundedJson(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) throw new Error("Response too large"); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export interface MagicaClient {
  catalog(signal?: AbortSignal): Promise<unknown>;
  estimate(name: MediaToolName, input: Record<string, unknown>, subModelId?: string): Promise<number>;
  start(name: MediaToolName, input: Record<string, unknown>, subModelId?: string): Promise<{ runId: string }>;
  read(runId: string, signal?: AbortSignal): Promise<ProviderRun>;
}
export function createMagicaClient(fetcher: typeof fetch = fetch): MagicaClient {
  const parsed = Environment.safeParse(process.env);
  if (!parsed.success) throw new ToolServiceError("CONFIGURATION", "Media tools are not configured. Please contact support.");
  const { MAGICA_API_KEY: key, MAGICA_API_BASE_URL: base } = parsed.data;
  async function request(path: string, body?: unknown, signal?: AbortSignal, createsWork = false) {
    const submitting = body !== undefined;
    try {
      const response = await fetcher(`${base.replace(/\/$/, "")}${path}`, {
        method: submitting ? "POST" : "GET", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(submitting ? 30_000 : 60_000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(submitting ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new ToolServiceError("AUTH", "The media service could not connect. Please contact support.");
        if (response.status === 429) throw new ToolServiceError("RATE_LIMIT", "Media tools are busy. Please try again shortly.");
        if (response.status === 402) throw new ToolServiceError("REJECTED", "There are not enough credits to run this tool.");
        if (response.status >= 400 && response.status < 500) throw new ToolServiceError("REJECTED", "The media request was rejected. Check the inputs and try again.");
        throw new Error("Upstream unavailable");
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof ToolServiceError) throw error;
      throw new ToolServiceError(createsWork ? "UNKNOWN" : "UNAVAILABLE", createsWork ?
        "The tool may have started, but its receipt was not received. It will not be submitted again automatically. Contact support before retrying." :
        "Unable to check this media task. Its saved receipt will be checked again.");
    }
  }
  return {
    catalog: signal => request("/v1/models/catalog", undefined, signal),
    async estimate(name, input, subModelId) {
      const value = await request("/v1/nodes/estimate-credits", { nodes: [{ type: name, data: input, ...(subModelId ? { subModelId } : {}) }] });
      const result = z.object({ estimates: z.array(z.object({ microcredits: z.number().int().nonnegative().max(2_147_483_647) })).length(1) }).safeParse(value);
      if (!result.success) throw new ToolServiceError("INVALID_RESULT", "Unable to estimate this task. Please try again.");
      return result.data.estimates[0].microcredits;
    },
    async start(name, input, subModelId) {
      const value = await request(`/v1/nodes/${name}/run`, { input, ...(subModelId ? { subModelId } : {}) }, undefined, true);
      const receipt = Receipt.safeParse(value);
      if (!receipt.success) throw new ToolServiceError("UNKNOWN", "The tool may have started without a valid receipt. Contact support before retrying.");
      return receipt.data;
    },
    async read(runId, signal) {
      const value = ProviderRunSchema.safeParse(await request(`/v1/nodes/runs/${encodeURIComponent(runId)}`, undefined, signal));
      if (!value.success || value.data.id !== runId) throw new ToolServiceError("INVALID_RESULT", "The media service returned an invalid result. The saved receipt can be checked again.");
      return value.data;
    },
  };
}
