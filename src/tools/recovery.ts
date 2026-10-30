import "server-only";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { magicaTool } from "../../trigger/magica-tool";
import { MEDIA_TASK_ID, MediaToolNameSchema } from "../contracts/tools";
import { getDatabase } from "../db/client";

export async function recoverMediaTools() {
  const db = getDatabase();
  const rows = await db.toolInvocation.findMany({ where: { name: { in: [...MediaToolNameSchema.options] }, OR: [{ status: "pending", run: { status: "running" } }, { status: { in: ["submitting", "running"] } }], reconcileAfter: { lte: new Date() } }, orderBy: [{ reconcileAfter: "asc" }, { id: "asc" }], take: 25, select: { id: true, providerRunId: true, status: true } });
  for (const row of rows) {
    const claim = await db.toolInvocation.updateMany({ where: { id: row.id, reconcileAfter: { lte: new Date() } }, data: { reconcileAfter: new Date(Date.now() + 10 * 60_000) } });
    if (!claim.count) continue;
    try {
      // A receipt permits safe read-only reconciliation in a new task even after
      // the original child exhausted its bounded polling window.
      const key = row.providerRunId || row.status === "submitting" ? `media-reconcile:${row.id}:${Math.floor(Date.now() / 600_000)}` : `media-tool:${row.id}`;
      await tasks.trigger<typeof magicaTool>(MEDIA_TASK_ID, { invocationId: row.id }, { idempotencyKey: await idempotencyKeys.create(key, { scope: "global" }), idempotencyKeyTTL: "30d" });
    } catch { await db.toolInvocation.update({ where: { id: row.id }, data: { reconcileAfter: new Date(Date.now() + 60_000) } }); }
  }
  return rows.length;
}
