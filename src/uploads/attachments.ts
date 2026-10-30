import "server-only";
import { AttachmentSchema, MAX_ATTACHMENTS, UPLOAD_URL_SECONDS } from "../contracts/uploads";
import { getDatabase } from "../db/client";
import type { Attachment } from "../generated/prisma/client";
import { getAttachmentStorage } from "./storage";
import { uploadsConfigured } from "./config";
import { decodeCursor, makePage } from "../chats/pagination";
import type { PageQuery } from "../contracts/chats";

export const ATTACHMENT_INCLUDE = { attachments: { orderBy: { position: "asc" as const }, take: MAX_ATTACHMENTS, include: { attachment: true } } };
export async function attachmentDto(row: Attachment) {
  let url: string | null = null, urlExpiresAt: string | null = null;
  if (row.status === "ready" && row.objectKey && uploadsConfigured()) {
    url = await getAttachmentStorage().readUrl(row.objectKey);
    urlExpiresAt = new Date(Date.now() + UPLOAD_URL_SECONDS * 1000).toISOString();
  }
  return AttachmentSchema.parse({ id: row.id, uploadId: row.uploadId, name: row.name, mimeType: row.mimeType, size: row.storedSize ?? row.size,
    kind: row.mimeType.split("/")[0], status: row.status, error: row.error, createdAt: row.createdAt.toISOString(), url, urlExpiresAt });
}
export async function resolveAttachments(clerkUserId: string, ids: string[]) {
  const rows = await getDatabase().attachment.findMany({ where: { id: { in: ids }, user: { clerkUserId } }, take: MAX_ATTACHMENTS });
  const byId = new Map(rows.map(row => [row.id, row]));
  return { items: await Promise.all(ids.flatMap(id => byId.has(id) ? [attachmentDto(byId.get(id)!)] : [])) };
}
export async function listAttachments(clerkUserId: string, query: PageQuery) {
  const boundary = decodeCursor(query.cursor, "attachments");
  const rows = await getDatabase().attachment.findMany({ where: { user: { clerkUserId }, status: "ready", ...(boundary ? { OR: [
    { createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } },
  ] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 });
  const page = makePage(rows, query.limit, "attachments");
  return { ...page, items: await Promise.all(page.items.map(attachmentDto)) };
}
