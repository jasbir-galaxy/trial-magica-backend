import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createAttachmentStorage } from "../src/uploads/storage";
import type { ProviderUpload } from "../src/uploads/provider";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async original => {
  const real = await original<typeof import("@aws-sdk/client-s3")>();
  return { ...real, S3Client: class { send = mocks.send; } };
});
const bytes = Buffer.from("test image bytes");
const file: ProviderUpload = { id: "source", name: "a.png", mime: "image/png", size: bytes.length, ssl_url: "https://a.transloadit.com/file.png", md5hash: createHash("md5").update(bytes).digest("hex"), user_meta: { attachmentId: "00000000-0000-4000-8000-000000000001" } };
beforeEach(() => {
  for (const [key, value] of Object.entries({ TRANSLOADIT_PLAN: "community", TRANSLOADIT_AUTH_KEY: "a".repeat(32), TRANSLOADIT_AUTH_SECRET: "fixture", UPLOAD_S3_ENDPOINT: "https://storage.example.test", UPLOAD_S3_REGION: "test", UPLOAD_S3_BUCKET: "trial-test", UPLOAD_S3_ACCESS_KEY_ID: "fixture", UPLOAD_S3_SECRET_ACCESS_KEY: "fixture" })) vi.stubEnv(key, value);
  mocks.send.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("streams a verified file with a private conditional write, explicit length and digest", async () => {
  mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockImplementationOnce(async command => {
    const parts = []; for await (const part of command.input.Body) parts.push(part);
    expect(Buffer.concat(parts)).toEqual(bytes); expect(command.input).toMatchObject({ IfNoneMatch: "*", ContentLength: bytes.length, ContentMD5: Buffer.from(file.md5hash, "hex").toString("base64"), Metadata: { source: "source", md5: file.md5hash } });
    expect(command.input.ACL).toBeUndefined(); return {};
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: { "content-length": String(bytes.length) } }));
  await createAttachmentStorage(fetcher).save("uploads/owner/file", file, "image/png", new AbortController().signal);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
});
it("recovers an already stored matching object without downloading or uploading it again", async () => {
  mocks.send.mockResolvedValueOnce({ ContentLength: bytes.length, Metadata: { source: "source", md5: file.md5hash } });
  const fetcher = vi.fn<typeof fetch>();
  await createAttachmentStorage(fetcher).save("uploads/owner/file", file, "image/png", new AbortController().signal);
  expect(fetcher).not.toHaveBeenCalled(); expect(mocks.send).toHaveBeenCalledTimes(1);
});
it("rejects mismatched existing objects and oversized responses", async () => {
  mocks.send.mockResolvedValueOnce({ ContentLength: 1, Metadata: {} });
  await expect(createAttachmentStorage().save("key", file, "image/png", new AbortController().signal)).rejects.toMatchObject({ retryable: false });
  mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: { "content-length": "999" } }));
  await expect(createAttachmentStorage(fetcher).save("key", file, "image/png", new AbortController().signal)).rejects.toMatchObject({ retryable: false });
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
it("does no work when cancelled and removes an object if storage did not enforce MD5", async () => {
  const aborted = new AbortController(); aborted.abort();
  await expect(createAttachmentStorage().save("key", file, "image/png", aborted.signal)).rejects.toThrow(); expect(mocks.send).not.toHaveBeenCalled();
  mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockImplementationOnce(async command => { let transferred = 0; for await (const chunk of command.input.Body) transferred += chunk.length; expect(transferred).toBe(bytes.length); return {}; }).mockResolvedValueOnce({});
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(bytes.length)));
  await expect(createAttachmentStorage(fetcher).save("key", file, "image/png", new AbortController().signal)).rejects.toMatchObject({ retryable: false });
  expect(mocks.send.mock.calls[2][0].constructor.name).toBe("DeleteObjectCommand");
});

it("supports B2 writes without conditional headers and removes only its exact object versions", async () => {
  vi.stubEnv("UPLOAD_S3_PROVIDER", "backblaze-b2");
  vi.stubEnv("UPLOAD_S3_ENDPOINT", "https://s3.us-east-005.backblazeb2.com");
  vi.stubEnv("UPLOAD_S3_REGION", "us-east-005");
  mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockImplementationOnce(async command => {
    if (command.input.IfNoneMatch) throw Object.assign(new Error("Conditional writes unsupported"), { $metadata: { httpStatusCode: 501 } });
    for await (const part of command.input.Body) expect(part.length).toBeGreaterThan(0);
    return { VersionId: "own-version" };
  });
  const storage = createAttachmentStorage(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));
  await storage.save("uploads/owner/file", file, "image/png", AbortSignal.timeout(5000));
  mocks.send.mockResolvedValueOnce({ Versions: [{ Key: "uploads/owner/file", VersionId: "own-version" }, { Key: "uploads/owner/file-neighbor", VersionId: "neighbor" }], DeleteMarkers: [{ Key: "uploads/owner/file", VersionId: "marker" }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
  await storage.remove("uploads/owner/file");
  expect(mocks.send.mock.calls[2][0].input).toMatchObject({ Prefix: "uploads/owner/file", MaxKeys: 100 });
  expect(mocks.send.mock.calls.slice(3).map(([command]) => command.input.VersionId)).toEqual(["own-version", "marker"]);
});
it("does not hide version cleanup failures", async () => {
  vi.stubEnv("UPLOAD_S3_PROVIDER", "backblaze-b2");
  vi.stubEnv("UPLOAD_S3_ENDPOINT", "https://s3.us-east-005.backblazeb2.com");
  vi.stubEnv("UPLOAD_S3_REGION", "us-east-005");
  mocks.send.mockResolvedValueOnce({ Versions: [{ Key: "uploads/file", VersionId: "version" }] }).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(createAttachmentStorage().remove("uploads/file")).rejects.toThrow("Storage unavailable");
});
