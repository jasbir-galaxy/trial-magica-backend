import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/db/client";
import { createChat } from "../src/chats/service";
import { createTurn, contextForRun } from "../src/agent/run-store";
import { createUpload, getOwnedUpload, bindUpload, cancelUpload } from "../src/uploads/store";
import { processUpload } from "../src/uploads/process";
import { resolveAttachments, listAttachments } from "../src/uploads/attachments";
import { MONTHLY_UPLOAD_BYTES, type CreateUpload } from "../src/contracts/uploads";
import { UploadServiceError, ProviderUploadSchema, type Assembly } from "../src/uploads/provider";
vi.mock("server-only", () => ({}));
const db = getDatabase(), alice = `upload_test_${randomUUID()}`, bob = `upload_other_${randomUUID()}`;
const month = new Date().toISOString().slice(0, 7);
let chatId: string;
const file = (name = "photo.png") => ({ id: randomUUID(), name, mimeType: "image/png" as const, size: 100 });
const input = (): CreateUpload => ({ chatId, requestId: randomUUID(), files: [file(), file("other.png")] });
const storage = () => ({ save: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined), readUrl: vi.fn().mockResolvedValue("https://storage.example.test/file") });
async function receipt(id: string): Promise<Assembly> {
  const row = await getOwnedUpload(alice, id);
  return { assembly_id: "a".repeat(32), params: row.signedParams, ok: "ASSEMBLY_COMPLETED", bytes_received: 200, bytes_usage: 200,
    uploads: row.attachments.map(f => ({ id: `provider-${f.id}`, name: f.name, mime: f.mimeType, size: f.size, ssl_url: "https://a.transloadit.com/file.png", md5hash: "a".repeat(32), user_meta: { attachmentId: f.id } })) };
}
async function setup() {
  const signed = await createUpload(alice, input()), value = await receipt(signed.upload.id);
  const provider = { read: vi.fn().mockResolvedValue(value), cancel: vi.fn().mockResolvedValue(undefined) }, store = storage();
  await bindUpload(alice, signed.upload.id, value.assembly_id, provider);
  return { id: signed.upload.id, signed, provider, storage: store, value };
}
beforeEach(async () => {
  const env = { TRANSLOADIT_PLAN: "community", TRANSLOADIT_AUTH_KEY: "a".repeat(32), TRANSLOADIT_AUTH_SECRET: "fixture-secret", UPLOAD_S3_ENDPOINT: "https://storage.example.test", UPLOAD_S3_REGION: "test", UPLOAD_S3_BUCKET: "trial-test", UPLOAD_S3_ACCESS_KEY_ID: "fixture", UPLOAD_S3_SECRET_ACCESS_KEY: "fixture", UPLOAD_PUBLIC_API_ORIGIN: "", TRIAL_INITIAL_CREDITS: "1000000" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  chatId = (await createChat(alice, { title: "Upload test" })).chat.id;
});
afterEach(async () => {
  const owned = { user: { clerkUserId: { in: [alice, bob] } } };
  await db.messageAttachment.deleteMany({ where: { chat: owned } });
  await db.creditLedger.deleteMany({ where: { account: owned } }); await db.creditReservation.deleteMany({ where: { account: owned } }); await db.creditAccount.deleteMany({ where: owned });
  await db.agentRun.deleteMany({ where: { chat: owned } }); await db.message.deleteMany({ where: { chat: owned } });
  await db.attachment.deleteMany({ where: owned }); await db.uploadBatch.deleteMany({ where: owned });
  await db.chat.deleteMany({ where: owned }); await db.user.deleteMany({ where: { clerkUserId: { in: [alice, bob] } } });
  await db.uploadQuota.deleteMany({ where: { month, uploads: { none: {} } } });
  vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());
it("reserves quota and persists one manifest under concurrent duplicate requests", async () => {
  const payload = input(); const values = await Promise.all(Array.from({ length: 3 }, () => createUpload(alice, payload)));
  expect(new Set(values.map(value => value.upload.id)).size).toBe(1);
  expect(await db.attachment.count({ where: { uploadId: values[0].upload.id } })).toBe(2);
  const quota = await db.uploadQuota.findUniqueOrThrow({ where: { month } }); expect(Number(quota.reservedBytes)).toBe(200 + 16384);
  await expect(createUpload(alice, { ...payload, files: [file()] })).rejects.toMatchObject({ status: 409 });
  expect(JSON.stringify(values[0])).not.toContain("fixture-secret");
});
it("rejects unauthorized reads, receipt binding and uploads", async () => {
  const value = await createUpload(alice, input());
  await expect(getOwnedUpload(bob, value.upload.id)).rejects.toMatchObject({ status: 404 });
  await expect(createUpload(bob, input())).rejects.toMatchObject({ status: 404 });
  const provider = { read: vi.fn(), cancel: vi.fn() };
  await expect(bindUpload(bob, value.upload.id, "a".repeat(32), provider)).rejects.toMatchObject({ status: 404 }); expect(provider.read).not.toHaveBeenCalled();
});
it("rejects quota exhaustion before creating files", async () => {
  await db.uploadQuota.create({ data: { month, usedBytes: BigInt(MONTHLY_UPLOAD_BYTES) } });
  await expect(createUpload(alice, input())).rejects.toMatchObject({ status: 413 });
  expect(await db.uploadBatch.count({ where: { chatId } })).toBe(0);
});
it("validates receipt ownership and refuses to replace a bound receipt", async () => {
  const fixture = await setup();
  await expect(bindUpload(alice, fixture.id, "b".repeat(32), fixture.provider)).rejects.toMatchObject({ status: 409 });
  fixture.value.params = JSON.stringify({ ...JSON.parse(fixture.value.params), nonce: randomUUID() });
  await expect(bindUpload(alice, fixture.id, "a".repeat(32), fixture.provider)).rejects.toMatchObject({ status: 400 });
});
it("saves once, restores from DB, and keeps selected message order and ownership", async () => {
  const f = await setup(); await processUpload(f.id, f); await processUpload(f.id, f);
  expect(f.storage.save).toHaveBeenCalledTimes(2);
  const saved = await getOwnedUpload(alice, f.id); expect(saved.status).toBe("completed");
  const ids = saved.attachments.map(file => file.id).reverse();
  const request = { requestId: randomUUID(), text: "Crop the first image", model: "openrouter/free" as const, attachmentIds: ids };
  const run = await createTurn(alice, chatId, request); const replay = await createTurn(alice, chatId, request);
  expect(replay.id).toBe(run.id); expect(run.userMessage.attachments?.map(file => file.id)).toEqual(ids);
  expect((await contextForRun(run.id))[0].content).toContain("other.png");
  await expect(createTurn(alice, chatId, { ...request, attachmentIds: [...ids].reverse() })).rejects.toMatchObject({ status: 409 });
  expect((await resolveAttachments(bob, ids)).items).toEqual([]);
  const other = (await createChat(bob, { title: "Other owner" })).chat.id;
  await expect(createTurn(bob, other, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ status: 400 });
  expect(await db.message.count({ where: { chatId: other } })).toBe(0);
  const first = await listAttachments(alice, { limit: 1 }); const second = await listAttachments(alice, { limit: 1, cursor: first.nextCursor! });
  expect(first.items[0].id).not.toBe(second.items[0].id);
  const quota = await db.uploadQuota.findUniqueOrThrow({ where: { month } }); expect(Number(quota.reservedBytes)).toBe(0); expect(Number(quota.usedBytes)).toBe(16584);
});
it("rejects unfinished attachments before persisting a turn", async () => {
  const upload = await createUpload(alice, input());
  await expect(createTurn(alice, chatId, { requestId: randomUUID(), text: "", model: "openrouter/free", attachmentIds: [upload.upload.attachments[0].id] })).rejects.toMatchObject({ status: 400 });
  expect(await db.message.count({ where: { chatId } })).toBe(0);
});
it("serializes workers and cancellation during storage without publishing a late file", async () => {
  const f = await setup();
  f.storage.save.mockImplementationOnce(async () => { expect((await processUpload(f.id, f)).status).toBe("busy"); await cancelUpload(alice, f.id); });
  await processUpload(f.id, f);
  const saved = await getOwnedUpload(alice, f.id); expect(saved.status).toBe("cancelled"); expect(saved.attachments.every(file => file.status === "cancelled")).toBe(true);
  expect(f.storage.remove).toHaveBeenCalledTimes(1);
  await processUpload(f.id, f); expect(f.provider.cancel).toHaveBeenCalledTimes(1);
});
it("does not trust mismatched detected MIME or unsafe result URLs", async () => {
  const f = await setup(); (f.value.uploads[0] as { mime: string }).mime = "text/html";
  await processUpload(f.id, f); expect((await getOwnedUpload(alice, f.id)).status).toBe("failed"); expect(f.storage.save).not.toHaveBeenCalled();
});
it("retries temporary failures, preserves completed files and settles terminal expiry", async () => {
  const f = await setup(); f.storage.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new UploadServiceError(true, "Temporary upload failure."));
  expect((await processUpload(f.id, f)).status).toBe("retrying");
  expect((await getOwnedUpload(alice, f.id)).attachments[0].status).toBe("ready");
  f.provider.read.mockRejectedValueOnce(new UploadServiceError(false, "This upload expired. Select the file again to retry."));
  await processUpload(f.id, f);
  const saved = await getOwnedUpload(alice, f.id); expect(saved.status).toBe("failed"); expect(saved.attachments.map(file => file.status)).toEqual(["ready", "failed"]); expect(saved.quotaSettled).toBe(true);
});

it("pins source identity and checksum before storage and rejects a changed receipt after a crash", async () => {
  const f = await setup();
  f.storage.save.mockImplementationOnce(async () => {
    const pinned = await getOwnedUpload(alice, f.id);
    expect(pinned.attachments.every(item => item.providerFileId && item.md5)).toBe(true);
    throw new UploadServiceError(true, "Temporary storage failure.");
  });
  expect((await processUpload(f.id, f)).status).toBe("retrying");
  const pinned = await getOwnedUpload(alice, f.id);
  const original = ProviderUploadSchema.parse(f.value.uploads[0]);
  expect(pinned.attachments[0].providerFileId).toBe(original.id);
  f.value.uploads[0] = { ...original, id: "replacement", md5hash: "b".repeat(32) };
  expect((await processUpload(f.id, f)).status).toBe("failed");
  expect(f.storage.save).toHaveBeenCalledTimes(1);
});
it("does not let a stale worker fail its replacement run", async () => {
  const f = await setup(), replacementToken = randomUUID();
  f.storage.save.mockImplementationOnce(async () => {
    await db.uploadBatch.update({ where: { id: f.id }, data: { leaseToken: replacementToken } });
    throw new UploadServiceError(false, "A stale failure.");
  });
  await processUpload(f.id, f);
  const current = await getOwnedUpload(alice, f.id);
  expect(current.status).toBe("processing"); expect(current.leaseToken).toBe(replacementToken);
});

it("persists a valid receipt that uses temporary R2 storage", async () => {
  const f = await setup();
  const original = ProviderUploadSchema.parse(f.value.uploads[0]);
  f.value.uploads[0] = { ...original, ssl_url: "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/receipt/file.png" };
  expect((await processUpload(f.id, f)).status).toBe("completed");
  expect((await getOwnedUpload(alice, f.id)).attachments.every(item => item.status === "ready")).toBe(true);
});
it("explains an invalid file receipt as a terminal failure without promising an automatic retry", async () => {
  const f = await setup(); f.value.uploads[0] = {};
  expect((await processUpload(f.id, f)).status).toBe("failed");
  expect((await getOwnedUpload(alice, f.id)).error).toBe("The uploaded file could not be verified. Select it again to retry.");
  expect(f.storage.save).not.toHaveBeenCalled();
});

it.each([60, 150])("accepts a processed result of %i bytes while retaining the original admission size", async size => {
  const f = await setup();
  const original = ProviderUploadSchema.parse(f.value.uploads[0]);
  f.value.uploads[0] = { ...original, size };
  expect((await processUpload(f.id, f)).status).toBe("completed");
  const stored = await getOwnedUpload(alice, f.id);
  expect(stored.attachments[0].size).toBe(100);
  const resolved = await resolveAttachments(alice, [stored.attachments[0].id]);
  expect(resolved.items[0].size).toBe(size);
  expect(f.storage.save.mock.calls[0][1].size).toBe(size);
});
it("does not restart cleanup when a completed failed receipt callback is repeated", async () => {
  const f = await setup(); f.value.uploads[0] = {};
  await processUpload(f.id, f); await processUpload(f.id, f);
  const reads = f.provider.read.mock.calls.length;
  await bindUpload(alice, f.id, f.value.assembly_id, f.provider);
  expect((await getOwnedUpload(alice, f.id)).cleanupPending).toBe(false);
  expect(f.provider.read.mock.calls.length).toBe(reads);
});

it("does not restart cleanup when a receipt becomes terminal during validation", async () => {
  const f = await setup();
  const provider = { ...f.provider, read: vi.fn(async () => {
    await db.uploadBatch.update({ where: { id: f.id }, data: { status: "failed", cleanupPending: false } });
    return f.value;
  }) };
  await bindUpload(alice, f.id, f.value.assembly_id, provider);
  expect((await getOwnedUpload(alice, f.id)).cleanupPending).toBe(false);
});
it("rejects changed processed sizes after pinning a receipt", async () => {
  const f = await setup();
  f.storage.save.mockRejectedValueOnce(new UploadServiceError(true, "Temporary storage failure."));
  expect((await processUpload(f.id, f)).status).toBe("retrying");
  const original = ProviderUploadSchema.parse(f.value.uploads[0]);
  f.value.uploads[0] = { ...original, size: original.size + 1 };
  expect((await processUpload(f.id, f)).status).toBe("failed");
  expect(f.storage.save).toHaveBeenCalledTimes(1);
});
