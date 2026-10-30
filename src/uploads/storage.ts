import "server-only";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { UPLOAD_URL_SECONDS } from "../contracts/uploads";
import { readUploadEnvironment } from "./config";
import { TemporaryMediaUrlSchema, UploadServiceError, type ProviderUpload } from "./provider";

// Callers must pin source identity/checksum under the upload lease before saving.
// B2 does not support conditional PutObject; retries may only write those same bytes.
export interface AttachmentStorage {
  save(key: string, file: ProviderUpload, mimeType: string, signal: AbortSignal): Promise<void>;
  remove(key: string): Promise<void>;
  readUrl(key: string): Promise<string>;
}
export function createAttachmentStorage(fetcher: typeof fetch = fetch): AttachmentStorage {
  const env = readUploadEnvironment();
  const client = new S3Client({ endpoint: env.UPLOAD_S3_ENDPOINT, region: env.UPLOAD_S3_REGION, forcePathStyle: env.UPLOAD_S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: env.UPLOAD_S3_ACCESS_KEY_ID, secretAccessKey: env.UPLOAD_S3_SECRET_ACCESS_KEY }, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  const versionedB2 = env.UPLOAD_S3_PROVIDER === "backblaze-b2";
  const object = (key: string) => ({ Bucket: env.UPLOAD_S3_BUCKET, Key: key });
  async function exists(key: string, file: ProviderUpload, signal: AbortSignal) {
    try {
      const result = await client.send(new HeadObjectCommand(object(key)), { abortSignal: signal });
      if (result.ContentLength !== file.size || result.Metadata?.source !== file.id || result.Metadata?.md5 !== file.md5hash) throw new UploadServiceError(false, "This file could not be verified. Select it again to retry.");
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
  async function remove(key: string) {
    const abortSignal = AbortSignal.timeout(30_000);
    if (!versionedB2) { await client.send(new DeleteObjectCommand(object(key)), { abortSignal }); return; }
    // A plain B2 delete only creates a marker and leaves billable bytes behind.
    // Only terminal, unready attachment keys may enter this cleanup path.
    for (let batch = 0; batch < 3; batch++) {
      const result = await client.send(new ListObjectVersionsCommand({ Bucket: env.UPLOAD_S3_BUCKET, Prefix: key, MaxKeys: 100 }), { abortSignal });
      const versions = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])].filter(version => version.Key === key);
      if (!versions.length) return;
      for (const version of versions) {
        if (!version.VersionId) throw new UploadServiceError(true, "File cleanup could not be verified yet.");
        await client.send(new DeleteObjectCommand({ ...object(key), VersionId: version.VersionId }), { abortSignal });
      }
      if (!result.IsTruncated) return;
    }
    throw new UploadServiceError(true, "File cleanup will continue on the next retry.");
  }
  return {
    async save(key, file, mimeType, signal) {
      signal.throwIfAborted();
      if (await exists(key, file, signal)) return;
      const response = await fetcher(TemporaryMediaUrlSchema.parse(file.ssl_url), { redirect: "error", signal, headers: { "Accept-Encoding": "identity" } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new UploadServiceError(response.status >= 500 || response.status === 429, "The temporary upload is unavailable. Select the file again if retrying does not help."); }
      if (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== file.size) { await response.body.cancel(); throw new UploadServiceError(false, "The uploaded file size could not be verified."); }
      let size = 0;
      const digest = createHash("md5");
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length; digest.update(chunk);
        done(size > file.size ? new Error("Upload exceeded its declared size.") : null, chunk);
      } });
      const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      source.on("error", error => bounded.destroy(error));
      source.pipe(bounded);
      try {
        const saved = await client.send(new PutObjectCommand({ ...object(key), Body: bounded, ContentLength: file.size, ContentType: mimeType,
          ContentMD5: Buffer.from(file.md5hash, "hex").toString("base64"), ...(versionedB2 ? {} : { IfNoneMatch: "*" }), Metadata: { source: file.id, md5: file.md5hash },
        }), { abortSignal: signal });
        if (size !== file.size || digest.digest("hex") !== file.md5hash) {
          await client.send(new DeleteObjectCommand({ ...object(key), ...(saved.VersionId ? { VersionId: saved.VersionId } : {}) }), { abortSignal: AbortSignal.timeout(15_000) });
          throw new UploadServiceError(false, "The uploaded file could not be verified.");
        }
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412 && await exists(key, file, signal)) return;
        throw error;
      } finally { source.destroy(); bounded.destroy(); }
    },
    remove,
    readUrl: key => getSignedUrl(client, new GetObjectCommand(object(key)), { expiresIn: UPLOAD_URL_SECONDS }),
  };
}

let sharedStorage: AttachmentStorage | undefined;
export function getAttachmentStorage() { return sharedStorage ??= createAttachmentStorage(); }
