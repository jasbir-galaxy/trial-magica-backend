import "server-only";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";
import { UploadServiceError, ProviderUploadSchema, createUploadProvider, type UploadProvider } from "./provider";
import { getAttachmentStorage, type AttachmentStorage } from "./storage";
import { ACTIVE_UPLOADS, UPLOAD_INCLUDE, verifyReceipt, settleUploadQuota, terminateUpload } from "./store";
import { HttpError } from "../http/errors";

const LEASE_MS = 11 * 60_000;
const normalizeMime = (value: string) => value === "audio/x-wav" ? "audio/wav" : value;
export async function processUpload(id: string, deps?: { provider?: UploadProvider; storage?: AttachmentStorage; signal?: AbortSignal }) {
  const db = getDatabase(), token = randomUUID(), now = new Date();
  const claimed = await db.uploadBatch.updateMany({ where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) } });
  if (!claimed.count) return { status: "busy" };
  const row = await db.uploadBatch.findUniqueOrThrow({ where: { id }, include: UPLOAD_INCLUDE });
  try {
    const provider = deps?.provider ?? createUploadProvider();
    if (["failed", "cancelled"].includes(row.status)) {
      if (row.cleanupPending) {
        if (row.assemblyId) await provider.cancel(row.assemblyId);
        const storage = deps?.storage ?? getAttachmentStorage();
        for (const file of row.attachments.filter(file => file.status !== "ready")) await storage.remove(file.objectKey);
        await db.uploadBatch.updateMany({ where: { id, leaseToken: token }, data: { cleanupPending: false } });
      }
      return { status: row.status };
    }
    if (row.status === "completed") return { status: "completed" };
    if (row.deadlineAt <= now) {
      await terminateUpload(id, "failed", "This upload expired. Select the files again to retry.", token);
      return { status: "failed" };
    }
    if (!row.assemblyId) return { status: "waiting_for_receipt" };
    const receipt = await provider.read(row.assemblyId);
    verifyReceipt(row, receipt);
    if (receipt.error || ["ASSEMBLY_CANCELED", "REQUEST_ABORTED"].includes(receipt.ok ?? "")) throw new UploadServiceError(false, "The upload did not finish. Select the files again to retry.");
    if (receipt.ok !== "ASSEMBLY_COMPLETED") return { status: "uploading" };
    const files = receipt.uploads.map(file => {
      const parsed = ProviderUploadSchema.safeParse(file);
      if (!parsed.success) throw new UploadServiceError(false, "The uploaded file could not be verified. Select it again to retry.");
      return parsed.data;
    });
    const byId = new Map(files.map(file => [file.user_meta.attachmentId, file]));
    if (files.length !== row.attachments.length || byId.size !== files.length) throw new UploadServiceError(false, "The uploaded files could not be matched. Select them again to retry.");
    // Community processing can watermark/trim originals. Admission uses the
    // original size; the bounded result size and hash describe stored bytes.
    for (const expected of row.attachments) {
      const actual = byId.get(expected.id);
      if (!actual || normalizeMime(actual.mime) !== normalizeMime(expected.mimeType)) throw new UploadServiceError(false, "The uploaded file type does not match. Select the original file again.");
    }
    const pinned = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "UploadBatch" WHERE id = ${id}::uuid FOR UPDATE`;
      const latest = await tx.uploadBatch.findUniqueOrThrow({ where: { id }, include: UPLOAD_INCLUDE });
      if (!ACTIVE_UPLOADS.includes(latest.status as typeof ACTIVE_UPLOADS[number]) || latest.leaseToken !== token) return false;
      // Persist the immutable receipt before any external write. A retry after
      // an ambiguous storage response must never overwrite a key with new bytes.
      for (const file of latest.attachments) {
        const actual = byId.get(file.id)!;
        if ((file.providerFileId !== null && file.providerFileId !== actual.id) || (file.md5 !== null && file.md5 !== actual.md5hash) || (file.storedSize !== null && file.storedSize !== actual.size)) {
          throw new UploadServiceError(false, "The uploaded file changed during recovery. Select the original file again.");
        }
        if (file.status !== "ready") await tx.attachment.update({ where: { id: file.id }, data: { providerFileId: actual.id, md5: actual.md5hash, storedSize: actual.size, status: "processing" } });
      }
      await tx.uploadBatch.update({ where: { id }, data: { status: "processing" } });
      return true;
    });
    if (!pinned) return { status: "cancelled" };
    const storage = deps?.storage ?? getAttachmentStorage();
    for (const file of row.attachments) {
      if (file.status === "ready") continue;
      const current = await db.uploadBatch.findUniqueOrThrow({ where: { id }, select: { status: true, leaseToken: true } });
      if (current.status !== "processing" || current.leaseToken !== token) return { status: "cancelled" };
      const actual = byId.get(file.id)!;
      const timeout = AbortSignal.timeout(100_000);
      await storage.save(file.objectKey, actual, file.mimeType, deps?.signal ? AbortSignal.any([timeout, deps.signal]) : timeout);
      // Cancel and completion serialize on the same row. Never expose an object
      // from an interrupted transfer as an attachment ready for a message.
      const saved = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "UploadBatch" WHERE id = ${id}::uuid FOR UPDATE`;
        const latest = await tx.uploadBatch.findUniqueOrThrow({ where: { id } });
        if (latest.status !== "processing" || latest.leaseToken !== token) return false;
        await tx.attachment.update({ where: { id: file.id }, data: { status: "ready", error: null } });
        return true;
      });
      if (!saved) {
        const latest = await db.attachment.findUniqueOrThrow({ where: { id: file.id }, select: { status: true } });
        // A replacement worker may own this object now. Only terminal, unready
        // files are disposable; never remove a newer worker's ready result.
        if (["cancelled", "failed"].includes(latest.status)) await storage.remove(file.objectKey);
        return { status: "cancelled" };
      }
    }
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "UploadBatch" WHERE id = ${id}::uuid FOR UPDATE`;
      const finished = await tx.uploadBatch.updateMany({ where: { id, leaseToken: token, status: "processing" }, data: { status: "completed", error: null, finishedAt: new Date() } });
      if (finished.count) await settleUploadQuota(tx, id, Math.max(receipt.bytes_received, receipt.bytes_usage));
    });
    return { status: "completed" };
  } catch (error) {
    const retryable = !(error instanceof HttpError) && !(error instanceof UploadServiceError && !error.retryable) && !(error instanceof Error && error.name === "ZodError");
    const message = error instanceof UploadServiceError ? error.message : "The file could not be saved yet. Your upload will be checked again.";
    const terminal = !retryable || row.attempts >= 5;
    if (terminal) await terminateUpload(id, "failed", retryable ? "The upload could not be saved. Select the files again to retry." : message, token);
    else await db.uploadBatch.updateMany({ where: { id, leaseToken: token, status: { in: [...ACTIVE_UPLOADS] } }, data: { attempts: { increment: 1 }, error: message } });
    return { status: terminal ? "failed" : "retrying" };
  } finally {
    await db.uploadBatch.updateMany({ where: { id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null, reconcileAfter: new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** row.attempts)) } });
  }
}
