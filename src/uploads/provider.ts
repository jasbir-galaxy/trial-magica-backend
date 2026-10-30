import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AssemblyIdSchema, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES } from "../contracts/uploads";
import { boundedJson } from "../tools/magica-client";
import { readUploadEnvironment } from "./config";

export class UploadServiceError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message); this.name = "UploadServiceError"; }
}
// Only use result URLs from a server-retrieved, manifest-validated Assembly.
// Public R2 object hosts are used by the upload service as temporary storage.
export const TemporaryMediaUrlSchema = z.url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value), host = url.hostname;
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
    (/^pub-[a-f0-9]{32}\.r2\.dev$/.test(host) || host.endsWith(".transloadit.com") || host.endsWith(".transloadit.net") || host.endsWith(".tlcdn.com") || host === "s3.amazonaws.com" || host.endsWith(".s3.amazonaws.com") || /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host));
}, "Invalid upload result address.");
export const ProviderUploadSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().max(1024), mime: z.string().max(100), size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  ssl_url: TemporaryMediaUrlSchema, md5hash: z.string().regex(/^[a-f0-9]{32}$/),
  user_meta: z.object({ attachmentId: z.uuid() }),
});
export const AssemblySchema = z.object({
  assembly_id: AssemblyIdSchema, params: z.string().max(32_000),
  ok: z.string().max(100).optional(), error: z.string().max(200).optional(),
  bytes_received: z.number().int().nonnegative().max(10_000_000_000).default(0), bytes_usage: z.number().nonnegative().max(100_000_000_000).default(0),
  uploads: z.array(z.unknown()).max(MAX_ATTACHMENTS).default([]),
});
export type Assembly = z.infer<typeof AssemblySchema>;
export type ProviderUpload = z.infer<typeof ProviderUploadSchema>;
export interface UploadProvider { read(id: string): Promise<Assembly>; cancel(id: string): Promise<void> }
export function signUpload(params: string, secret = readUploadEnvironment().TRANSLOADIT_AUTH_SECRET) {
  return `sha384:${createHmac("sha384", secret).update(params).digest("hex")}`;
}
export function verifyUploadWebhook(payload: string, signature: string, secret = readUploadEnvironment().TRANSLOADIT_AUTH_SECRET) {
  if (!/^[a-f0-9]{40}$/.test(signature)) return false;
  const expected = createHmac("sha1", secret).update(payload).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
export function createUploadProvider(fetcher: typeof fetch = fetch): UploadProvider {
  async function request(id: string, method: "GET" | "DELETE") {
    const target = `https://api2.transloadit.com/assemblies/${AssemblyIdSchema.parse(id)}`;
    try {
      const response = await fetcher(target, { method, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UploadServiceError(response.status >= 500 || response.status === 429, response.status === 404 ? "This upload expired. Select the file again to retry." : "Unable to check this upload. Please try again.");
      }
      const value = AssemblySchema.parse(await boundedJson(response, 1_000_000));
      if (value.assembly_id !== id) throw new Error("Mismatched upload receipt.");
      return value;
    } catch (error) {
      if (error instanceof UploadServiceError) throw error;
      throw new UploadServiceError(true, "The upload connection was interrupted. Your saved progress will be checked again.");
    }
  }
  return { read: id => request(id, "GET"), cancel: async id => { await request(id, "DELETE"); } };
}
