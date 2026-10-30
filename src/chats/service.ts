import "server-only";
import { ATTACHMENT_INCLUDE, attachmentDto } from "../uploads/attachments";
import { createHash, randomUUID } from "node:crypto";
import { TOOL_INCLUDE, toolDto } from "../tools/store";
import { getDatabase } from "../db/client";
import { Prisma } from "../generated/prisma/client";
import { ACTIVE_STATUSES } from "../contracts/runs";
import { ACTIVE_UPLOADS } from "../uploads/store";
import type { CreateChat, ChatListQuery, MessagePageQuery } from "../contracts/chats";
import { HttpError } from "../http/errors";
import { decodeCursor, makePage } from "./pagination";

const CHAT_SCOPE = "chats";
const chatSelect = { id: true, title: true, isFavorite: true, deletedAt: true, createdAt: true, updatedAt: true } as const;
const notFound = () => new HttpError(404, "NOT_FOUND", "Chat not found.");
const dateDto = <T extends { createdAt: Date; updatedAt: Date }>(row: T) => ({
  ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});
const chatDto = <T extends { createdAt: Date; updatedAt: Date; deletedAt: Date | null }>(chat: T) => ({
  ...dateDto(chat), deletedAt: chat.deletedAt?.toISOString() ?? null,
});

export async function createChat(clerkUserId: string, input: CreateChat) {
  const requestId = input.requestId ?? randomUUID();
  return getDatabase().$transaction(async (tx) => {
    // Unique constraints plus ON CONFLICT make concurrent first requests safe.
    await tx.user.createMany({ data: [{ clerkUserId }], skipDuplicates: true });
    const user = await tx.user.findUniqueOrThrow({ where: { clerkUserId }, select: { id: true } });
    const created = await tx.chat.createMany({
      data: [{ userId: user.id, requestId, title: input.title }], skipDuplicates: true,
    });
    const chat = await tx.chat.findUniqueOrThrow({
      where: { userId_requestId: { userId: user.id, requestId } }, select: chatSelect,
    });
    if (chat.deletedAt) throw new HttpError(409, "CONFLICT", "This chat is in Trash. Restore it before continuing.");
    if (chat.title !== input.title) {
      throw new HttpError(409, "CONFLICT", "This request ID was already used with different chat details.");
    }
    return { chat: chatDto(chat), created: created.count === 1 };
  });
}

export async function listChats(clerkUserId: string, query: ChatListQuery) {
  const q = query.q?.trim() ?? "", view = query.view ?? "all";
  // Preserve legacy cursors; filters get distinct, bounded scopes.
  const scope = !q && view === "all" ? CHAT_SCOPE : `${CHAT_SCOPE}:${createHash("sha256").update(JSON.stringify([q, view])).digest("hex")}`;
  const boundary = decodeCursor(query.cursor, scope);
  const db = getDatabase();
  const owner = await db.user.findUnique({ where: { clerkUserId }, select: { id: true } });
  if (!owner) return makePage([], query.limit, scope);
  const rows = q ? await db.$queryRaw<Array<{ id: string; title: string; isFavorite: boolean; deletedAt: Date | null; createdAt: Date; updatedAt: Date }>>(Prisma.sql`
    WITH matches AS (
      SELECT c.id FROM "Chat" c WHERE c."userId" = ${owner.id}::uuid
        AND to_tsvector('simple', c.title) @@ websearch_to_tsquery('simple', ${q})
      UNION
      SELECT m."chatId" FROM "Message" m JOIN "Chat" c ON c.id = m."chatId"
        WHERE c."userId" = ${owner.id}::uuid
        AND to_tsvector('simple', public.chat_message_text(m.content)) @@ websearch_to_tsquery('simple', ${q})
    )
    SELECT c.id, c.title, c."isFavorite", c."deletedAt", c."createdAt", c."updatedAt"
    FROM "Chat" c JOIN matches ON matches.id = c.id
    WHERE c."userId" = ${owner.id}::uuid
      AND ${view === "trash" ? Prisma.sql`c."deletedAt" IS NOT NULL` : Prisma.sql`c."deletedAt" IS NULL`}
      ${view === "favorites" ? Prisma.sql`AND c."isFavorite" = true` : Prisma.empty}
      ${boundary ? Prisma.sql`AND (c."createdAt", c.id) < (${boundary.createdAt}, ${boundary.id}::uuid)` : Prisma.empty}
    ORDER BY c."createdAt" DESC, c.id DESC LIMIT ${query.limit + 1}
  `) : await db.chat.findMany({
    where: { userId: owner.id, deletedAt: view === "trash" ? { not: null } : null,
      ...(view === "favorites" ? { isFavorite: true } : {}), ...(boundary ? { OR: [
        { createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } },
      ] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1, select: chatSelect,
  });
  const page = makePage(rows, query.limit, scope);
  return { ...page, items: page.items.map(chatDto) };
}

async function lockOwnedChat(tx: Prisma.TransactionClient, clerkUserId: string, chatId: string) {
  const rows = await tx.$queryRaw<{ id: string; deletedAt: Date | null }[]>`
    SELECT c.id, c."deletedAt" FROM "Chat" c JOIN "User" u ON u.id = c."userId"
    WHERE c.id = ${chatId}::uuid AND u."clerkUserId" = ${clerkUserId} FOR UPDATE OF c`;
  if (!rows.length) throw notFound();
  return rows[0];
}
export async function favoriteChat(clerkUserId: string, chatId: string, isFavorite: boolean) {
  return getDatabase().$transaction(async tx => {
    if ((await lockOwnedChat(tx, clerkUserId, chatId)).deletedAt) throw notFound();
    return chatDto(await tx.chat.update({ where: { id: chatId }, data: { isFavorite }, select: chatSelect }));
  });
}
export async function deleteChat(clerkUserId: string, chatId: string) {
  return getDatabase().$transaction(async tx => {
    const chat = await lockOwnedChat(tx, clerkUserId, chatId);
    if (chat.deletedAt) return { id: chat.id, deletedAt: chat.deletedAt.toISOString() };
    // Admission also locks this chat, so work cannot begin after these checks.
    const run = await tx.agentRun.findFirst({ where: { chatId, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } });
    const tool = await tx.toolInvocation.findFirst({ where: { chatId, status: { in: ["awaiting_approval", "pending", "submitting", "running", "unknown"] } }, select: { id: true } });
    const upload = await tx.uploadBatch.findFirst({ where: { chatId, status: { in: [...ACTIVE_UPLOADS] } }, select: { id: true } });
    if (run || tool || upload) throw new HttpError(409, "CHAT_BUSY", "This chat still has unfinished work. Stop or finish its replies and uploads before deleting it.");
    const deletedAt = new Date();
    await tx.chat.update({ where: { id: chatId }, data: { deletedAt } });
    return { id: chatId, deletedAt: deletedAt.toISOString() };
  });
}
export async function restoreChat(clerkUserId: string, chatId: string) {
  return getDatabase().$transaction(async tx => {
    await lockOwnedChat(tx, clerkUserId, chatId);
    return chatDto(await tx.chat.update({ where: { id: chatId }, data: { deletedAt: null }, select: chatSelect }));
  });
}

export async function getChat(clerkUserId: string, chatId: string) {
  const chat = await getDatabase().chat.findFirst({
    where: { id: chatId, deletedAt: null, user: { clerkUserId } }, select: chatSelect,
  });
  if (!chat) throw notFound();
  return chatDto(chat);
}

export async function listMessages(clerkUserId: string, chatId: string, query: MessagePageQuery) {
  await getChat(clerkUserId, chatId);
  const scope = query.order === "desc" ? `${chatId}:desc` : chatId;
  const boundary = decodeCursor(query.cursor, scope);
  const comparison = query.order === "desc" ? "lt" : "gt";
  const rows = await getDatabase().message.findMany({
    where: { chatId, chat: { user: { clerkUserId } }, ...(boundary ? { OR: [
      { createdAt: { [comparison]: boundary.createdAt } },
      { createdAt: boundary.createdAt, id: { [comparison]: boundary.id } },
    ] } : {}) },
    orderBy: [{ createdAt: query.order }, { id: query.order }], take: query.limit + 1,
    select: { id: true, chatId: true, role: true, status: true, content: true, error: true, createdAt: true, updatedAt: true, ...TOOL_INCLUDE, ...ATTACHMENT_INCLUDE },
  });
  const page = makePage(rows, query.limit, scope);
  return { ...page, items: await Promise.all(page.items.map(async row => ({ ...dateDto(row), attachments: await Promise.all(row.attachments.map(link => attachmentDto(link.attachment))), tools: row.tools.map(toolDto) }))) };
}
