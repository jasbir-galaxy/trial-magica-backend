import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabase } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { HttpError } from "../http/errors";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, MONTHLY_UPLOAD_BYTES, UPLOAD_SIGNATURE_MS, UPLOAD_LIFETIME_MS, UPLOAD_OVERHEAD_BYTES, UploadMimeSchema, UploadPolicySchema, UploadSchema, SignedUploadSchema, type CreateUpload } from "../contracts/uploads";
import { attachmentDto } from "./attachments";
import { readUploadEnvironment, uploadsConfigured } from "./config";
import { signUpload, type Assembly, createUploadProvider, type UploadProvider } from "./provider";

export const ACTIVE_UPLOADS = ["created", "uploading", "processing"] as const;
export const UPLOAD_INCLUDE = { attachments: { orderBy: { position: "asc" as const }, take: MAX_ATTACHMENTS } };
export type UploadRow = Prisma.UploadBatchGetPayload<{ include: typeof UPLOAD_INCLUDE }>;
export async function uploadDto(row: UploadRow) {
  return UploadSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), attachments: await Promise.all(row.attachments.map(attachmentDto)) });
}
export async function getOwnedUpload(clerkUserId: string, id: string) {
  const row = await getDatabase().uploadBatch.findFirst({ where: { id, user: { clerkUserId } }, include: UPLOAD_INCLUDE });
  if (!row) throw new HttpError(404, "NOT_FOUND", "Upload not found.");
  return row;
}
export async function uploadPolicy() {
  const quota = await getDatabase().uploadQuota.findUnique({ where: { month: new Date().toISOString().slice(0, 7) } });
  return UploadPolicySchema.parse({ enabled: uploadsConfigured(), message: uploadsConfigured() ? null : "File uploads are not configured yet. You can still send a message.", maxFiles: MAX_ATTACHMENTS, maxFileBytes: MAX_UPLOAD_BYTES,
    mimeTypes: UploadMimeSchema.options, monthlyLimitBytes: MONTHLY_UPLOAD_BYTES, remainingBytes: Math.max(0, MONTHLY_UPLOAD_BYTES - Number((quota?.usedBytes ?? BigInt(0)) + (quota?.reservedBytes ?? BigInt(0)))) });
}
export async function createUpload(clerkUserId: string, input: CreateUpload) {
  const env = readUploadEnvironment();
  const manifestHash = createHash("sha256").update(JSON.stringify({ chatId: input.chatId, files: input.files })).digest("hex");
  const row = await getDatabase().$transaction(async tx => {
    // Serialize admission per owner, not per file transfer or agent turn.
    const owned = await tx.$queryRaw<{ id: string }[]>`SELECT u.id FROM "User" u JOIN "Chat" c ON c."userId" = u.id WHERE c.id = ${input.chatId}::uuid AND c."deletedAt" IS NULL AND u."clerkUserId" = ${clerkUserId} FOR UPDATE OF c, u`;
    if (!owned.length) throw new HttpError(404, "NOT_FOUND", "Chat not found.");
    const userId = owned[0].id;
    const prior = await tx.uploadBatch.findUnique({ where: { userId_requestId: { userId, requestId: input.requestId } }, include: UPLOAD_INCLUDE });
    if (prior) {
      if (prior.manifestHash !== manifestHash) throw new HttpError(409, "CONFLICT", "This upload request already belongs to different files.");
      if (prior.expiresAt <= new Date()) throw new HttpError(409, "UPLOAD_EXPIRED", "This upload request expired. Restore the existing upload or select the files again.");
      return prior;
    }
    const recent = await tx.uploadBatch.findMany({ where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } }, take: 10, select: { id: true } });
    const active = await tx.uploadBatch.findMany({ where: { userId, status: { in: [...ACTIVE_UPLOADS] } }, take: 5, select: { id: true } });
    if (recent.length >= 10 || active.length >= 5) throw new HttpError(429, "UPLOAD_LIMIT", "Please finish or cancel your existing uploads before starting more.");
    if (await tx.attachment.findFirst({ where: { id: { in: input.files.map(file => file.id) } }, select: { id: true } })) throw new HttpError(409, "CONFLICT", "These files already belong to an upload. Restore that upload or select the files again.");
    const id = randomUUID(), now = new Date(), month = now.toISOString().slice(0, 7);
    const reservedBytes = BigInt(input.files.reduce((sum, file) => sum + file.size, 0) + UPLOAD_OVERHEAD_BYTES);
    await tx.uploadQuota.createMany({ data: [{ month }], skipDuplicates: true });
    const quota = await tx.$queryRaw<{ reservedBytes: bigint; usedBytes: bigint }[]>`SELECT "reservedBytes", "usedBytes" FROM "UploadQuota" WHERE month = ${month} FOR UPDATE`;
    if (quota[0].reservedBytes + quota[0].usedBytes + reservedBytes > BigInt(MONTHLY_UPLOAD_BYTES)) throw new HttpError(413, "UPLOAD_QUOTA", "The monthly upload allowance is full. Try again next month or use files already in your media library.");
    await tx.uploadQuota.update({ where: { month }, data: { reservedBytes: { increment: reservedBytes } } });
    const expiresAt = new Date(now.getTime() + UPLOAD_SIGNATURE_MS);
    const signedParams = JSON.stringify({ auth: { key: env.TRANSLOADIT_AUTH_KEY, expires: expiresAt.toISOString(), max_size: Number(reservedBytes), max_number_of_files: input.files.length },
      nonce: id, fields: { uploadId: id, manifestHash }, steps: { ":original": { robot: "/upload/handle", result: true } },
      ...(env.UPLOAD_PUBLIC_API_ORIGIN ? { notify_url: `${env.UPLOAD_PUBLIC_API_ORIGIN}/api/uploads/webhook` } : {}) });
    await tx.uploadBatch.create({ data: { id, userId, chatId: input.chatId, requestId: input.requestId, manifestHash, signedParams, expiresAt,
      deadlineAt: new Date(now.getTime() + UPLOAD_LIFETIME_MS), quotaMonth: month, reservedBytes,
    } });
    await tx.attachment.createMany({ data: input.files.map((file, position) => ({ id: file.id, uploadId: id, userId, name: file.name, mimeType: file.mimeType, size: file.size, position, objectKey: `uploads/${userId}/${file.id}` })) });
    return tx.uploadBatch.findUniqueOrThrow({ where: { id }, include: UPLOAD_INCLUDE });
  });
  return SignedUploadSchema.parse({ upload: await uploadDto(row), params: row.signedParams, signature: signUpload(row.signedParams), expiresAt: row.expiresAt.toISOString() });
}
const ReceiptParamsSchema = z.object({ nonce: z.uuid(), fields: z.object({ uploadId: z.uuid(), manifestHash: z.string() }), steps: z.record(z.string(), z.unknown()) });
export function verifyReceipt(row: Pick<UploadRow, "id" | "manifestHash" | "signedParams">, receipt: Assembly) {
  const parsed = ReceiptParamsSchema.safeParse((() => { try { return JSON.parse(receipt.params); } catch { return null; } })());
  if (!parsed.success || parsed.data.nonce !== row.id || parsed.data.fields.uploadId !== row.id || parsed.data.fields.manifestHash !== row.manifestHash || JSON.stringify(parsed.data.steps) !== JSON.stringify(JSON.parse(row.signedParams).steps)) {
    throw new HttpError(400, "INVALID_UPLOAD", "This upload receipt does not match the selected files.");
  }
}
export async function bindUpload(clerkUserId: string, id: string, assemblyId: string, provider: UploadProvider = createUploadProvider()) {
  const row = await getOwnedUpload(clerkUserId, id);
  if (row.assemblyId && row.assemblyId !== assemblyId) throw new HttpError(409, "CONFLICT", "This upload already has a receipt. Restore the existing upload.");
  // A validated, terminal receipt is immutable. Duplicate browser callbacks
  // must not restart provider cancellation or storage cleanup.
  if (row.assemblyId === assemblyId && !ACTIVE_UPLOADS.some(status => status === row.status)) return uploadDto(row);
  const receipt = await provider.read(assemblyId);
  verifyReceipt(row, receipt);
  await getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "UploadBatch" WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.uploadBatch.findUniqueOrThrow({ where: { id } });
    if (current.assemblyId && current.assemblyId !== assemblyId) throw new HttpError(409, "CONFLICT", "This upload already has a receipt.");
    if (current.assemblyId === assemblyId && !ACTIVE_UPLOADS.some(status => status === current.status)) return;
    const duplicate = await tx.uploadBatch.findUnique({ where: { assemblyId }, select: { id: true } });
    if (duplicate && duplicate.id !== id) throw new HttpError(400, "INVALID_UPLOAD", "This upload receipt is unavailable.");
    await tx.uploadBatch.update({ where: { id }, data: { assemblyId, reconcileAfter: new Date(), cleanupPending: ["cancelled", "failed"].includes(current.status), ...(current.status === "created" ? { status: "uploading" } : {}) } });
  });
  if (row.status === "cancelled" || row.status === "failed") await provider.cancel(assemblyId);
  return uploadDto(await getOwnedUpload(clerkUserId, id));
}
// Ambiguous, failed and cancelled uploads retain their reserved usage as a
// conservative charge. A cancelled receipt may still accrue provider usage.
export async function settleUploadQuota(tx: Prisma.TransactionClient, id: string, actualBytes?: number) {
  const row = await tx.uploadBatch.findUniqueOrThrow({ where: { id } });
  if (row.quotaSettled) return;
  const changed = await tx.uploadBatch.updateMany({ where: { id, quotaSettled: false }, data: { quotaSettled: true } });
  if (!changed.count) return;
  const used = actualBytes === undefined ? row.reservedBytes : BigInt(Math.ceil(actualBytes));
  await tx.uploadQuota.update({ where: { month: row.quotaMonth }, data: { reservedBytes: { decrement: row.reservedBytes }, usedBytes: { increment: used > row.reservedBytes ? used : row.reservedBytes } } });
}
export async function terminateUpload(id: string, status: "failed" | "cancelled", error: string, leaseToken?: string) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "UploadBatch" WHERE id = ${id}::uuid FOR UPDATE`;
    const changed = await tx.uploadBatch.updateMany({ where: { id, ...(leaseToken ? { leaseToken } : {}), status: { in: [...ACTIVE_UPLOADS] } }, data: { status, error, finishedAt: new Date(), cleanupPending: true, reconcileAfter: new Date() } });
    if (changed.count) {
      await tx.attachment.updateMany({ where: { uploadId: id, status: { in: ["uploading", "processing"] } }, data: { status, error } });
      await settleUploadQuota(tx, id);
    }
  });
}
export async function cancelUpload(clerkUserId: string, id: string) {
  await getOwnedUpload(clerkUserId, id);
  await terminateUpload(id, "cancelled", "Upload cancelled. Select the file again to retry.");
  return uploadDto(await getOwnedUpload(clerkUserId, id));
}
