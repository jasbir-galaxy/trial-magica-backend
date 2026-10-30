import { afterEach, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { CreateUploadSchema, MAX_UPLOAD_BYTES, AttachmentIdListSchema } from "../src/contracts/uploads";
import { signUpload, verifyUploadWebhook, TemporaryMediaUrlSchema, createUploadProvider } from "../src/uploads/provider";
import { SendTurnSchema } from "../src/contracts/runs";
import { readUploadEnvironment } from "../src/uploads/config";
vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());
it("bounds metadata, files, types, paths and duplicate IDs", () => {
  const file = { id: randomUUID(), name: "image.png", mimeType: "image/png", size: 10 };
  const input = { chatId: randomUUID(), requestId: randomUUID(), files: [file] };
  expect(CreateUploadSchema.safeParse(input).success).toBe(true);
  for (const change of [{ size: MAX_UPLOAD_BYTES + 1 }, { size: 0 }, { name: "../image.png" }, { name: "a\u0000.png" }, { mimeType: "image/svg+xml" }]) expect(CreateUploadSchema.safeParse({ ...input, files: [{ ...file, ...change }] }).success).toBe(false);
  expect(CreateUploadSchema.safeParse({ ...input, files: [file, file] }).success).toBe(false);
  expect(CreateUploadSchema.safeParse({ ...input, files: Array.from({ length: 6 }, () => ({ ...file, id: randomUUID() })) }).success).toBe(false);
  expect(AttachmentIdListSchema.safeParse([file.id, file.id]).success).toBe(false);
});
it("allows attachment-only turns and keeps text-only clients compatible", () => {
  const base = { requestId: randomUUID(), text: "" };
  expect(SendTurnSchema.safeParse(base).success).toBe(false);
  expect(SendTurnSchema.parse({ ...base, attachmentIds: [randomUUID()] }).model).toBe("openrouter/free");
  expect(SendTurnSchema.parse({ ...base, text: "hello" }).attachmentIds).toBeUndefined();
});
it("signs exact parameters and authenticates exact notification bytes", () => {
  const payload = '{"nonce":"example"}', secret = "fixture-secret";
  expect(signUpload(payload, secret)).toBe(`sha384:${createHmac("sha384", secret).update(payload).digest("hex")}`);
  const signature = createHmac("sha1", secret).update(payload).digest("hex");
  expect(verifyUploadWebhook(payload, signature, secret)).toBe(true);
  expect(verifyUploadWebhook(payload + " ", signature, secret)).toBe(false);
  expect(verifyUploadWebhook(payload, "sha1:" + signature, secret)).toBe(false);
});
it("rejects local, redirected, credential-bearing and unsupported result addresses", () => {
  for (const url of ["http://localhost/a", "https://127.0.0.1/a", "https://transloadit.com.evil.test/a", "https://user:pass@a.transloadit.com/a", "https://a.transloadit.com:444/a", "file:///tmp/a"]) expect(TemporaryMediaUrlSchema.safeParse(url).success).toBe(false);
  expect(TemporaryMediaUrlSchema.safeParse("https://s3.amazonaws.com/example/a.png").success).toBe(true);
});
it("uses fixed status endpoints and classifies expiry and temporary failures safely", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private error", { status: 404 })).mockResolvedValueOnce(new Response("private error", { status: 429 }));
  const provider = createUploadProvider(fetcher);
  await expect(provider.read("a".repeat(32))).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("expired") });
  await expect(provider.read("a".repeat(32))).rejects.toMatchObject({ retryable: true });
  expect(fetcher.mock.calls[0][0]).toBe(`https://api2.transloadit.com/assemblies/${"a".repeat(32)}`);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
});
it("fails closed without upload configuration or when a paid plan is selected", () => {
  expect(() => readUploadEnvironment({})).toThrow("not configured");
  expect(() => readUploadEnvironment({ TRANSLOADIT_PLAN: "paid" })).toThrow("not configured");
});

it("only enables B2 behavior for a matching B2 endpoint and region", () => {
  const env = { TRANSLOADIT_PLAN: "community", TRANSLOADIT_AUTH_KEY: "a".repeat(32), TRANSLOADIT_AUTH_SECRET: "fixture", UPLOAD_S3_PROVIDER: "backblaze-b2", UPLOAD_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com", UPLOAD_S3_REGION: "us-east-005", UPLOAD_S3_BUCKET: "trial-test", UPLOAD_S3_ACCESS_KEY_ID: "fixture", UPLOAD_S3_SECRET_ACCESS_KEY: "fixture" };
  expect(readUploadEnvironment(env).UPLOAD_S3_PROVIDER).toBe("backblaze-b2");
  for (const endpoint of ["invalid", "https://storage.example.test"]) expect(() => readUploadEnvironment({ ...env, UPLOAD_S3_ENDPOINT: endpoint })).toThrow("not configured");
});

it("accepts provider R2 temporary objects while rejecting lookalikes and unsafe URLs", () => {
  expect(TemporaryMediaUrlSchema.safeParse("https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/receipt/file.png").success).toBe(true);
  for (const url of ["invalid", "http://pub-e8fef8c0e03b44acb340577811800829.r2.dev/file", "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev.evil.test/file", "https://evil.r2.dev/file", "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev:444/file", "https://user:pass@pub-e8fef8c0e03b44acb340577811800829.r2.dev/file"]) expect(TemporaryMediaUrlSchema.safeParse(url).success).toBe(false);
});
