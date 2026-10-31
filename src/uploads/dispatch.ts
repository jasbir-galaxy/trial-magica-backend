import { logEvent } from "../observability/log";
import "server-only";
import { tasks } from "@trigger.dev/sdk";
import { getDatabase } from "../db/client";
import { UPLOAD_TASK_ID } from "../contracts/uploads";
import { ACTIVE_UPLOADS } from "./store";
export async function dispatchUpload(uploadId: string) {
  try {
    // Receipts and the recovery scan can race; the database lease is authoritative.
    await tasks.trigger(UPLOAD_TASK_ID, { uploadId }, { idempotencyKey: `upload:${uploadId}:${Math.floor(Date.now() / 30_000)}`, idempotencyKeyTTL: "1h" });
    return true;
  } catch {
    logEvent("warn", "Upload dispatch pending recovery", { uploadId });
    return false;
  }
}
export async function recoverUploads() {
  const rows = await getDatabase().uploadBatch.findMany({ where: { reconcileAfter: { lte: new Date() }, OR: [{ status: { in: [...ACTIVE_UPLOADS] } }, { cleanupPending: true }] }, orderBy: [{ reconcileAfter: "asc" }, { id: "asc" }], take: 25, select: { id: true } });
  await Promise.all(rows.map(async row => {
    await getDatabase().uploadBatch.updateMany({ where: { id: row.id, reconcileAfter: { lte: new Date() } }, data: { reconcileAfter: new Date(Date.now() + 60_000) } });
    await dispatchUpload(row.id);
  }));
  return rows.length;
}
