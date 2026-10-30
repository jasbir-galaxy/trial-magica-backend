import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getDatabase } from "../db/client";
import { HttpError } from "../http/errors";
import { ApiKeySchema, ApiKeyListSchema, CreatedApiKeySchema, API_RATE_LIMIT, MAX_API_KEYS, type CreateApiKey, type ApiScope } from "../contracts/public-api";
const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");
const invalid = () => new HttpError(401, "UNAUTHORIZED", "Provide a valid, unexpired API key.");
const metadata = (row: { createdAt: Date; expiresAt: Date; lastUsedAt: Date | null }) => ApiKeySchema.parse({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null });
export async function createApiKey(clerkUserId: string, input: CreateApiKey) {
  return getDatabase().$transaction(async tx => {
    await tx.user.createMany({ data: [{ clerkUserId }], skipDuplicates: true });
    const [user] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE "clerkUserId"=${clerkUserId} FOR UPDATE`;
    if (await tx.publicApiKey.findUnique({ where: { userId_requestId: { userId: user.id, requestId: input.requestId } } })) throw new HttpError(409, "KEY_ALREADY_CREATED", "This key was already created. If its secret was lost, revoke it and create a new key.");
    if (await tx.publicApiKey.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } } }) >= MAX_API_KEYS) throw new HttpError(409, "KEY_LIMIT", "Revoke an unused key before creating another.");
    const secret = `mgtrial_${randomBytes(32).toString("base64url")}`;
    const row = await tx.publicApiKey.create({ data: { userId: user.id, requestId: input.requestId, name: input.name, prefix: secret.slice(0, 16), tokenHash: digest(secret), scopes: input.scopes, expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) } });
    return CreatedApiKeySchema.parse({ key: metadata(row), secret });
  });
}
export async function listApiKeys(clerkUserId: string) {
  return ApiKeyListSchema.parse({ items: (await getDatabase().publicApiKey.findMany({ where: { user: { clerkUserId }, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_API_KEYS })).map(metadata) });
}
export async function revokeApiKey(clerkUserId: string, id: string) {
  const result = await getDatabase().publicApiKey.updateMany({ where: { id, user: { clerkUserId } }, data: { revokedAt: new Date() } });
  if (!result.count) throw new HttpError(404, "NOT_FOUND", "API key not found.");
  return { success: true as const };
}
export async function authenticateApiKey(request: Request, scope: ApiScope) {
  const match = /^Bearer (mgtrial_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw invalid();
  const db = getDatabase(), now = new Date();
  const key = await db.publicApiKey.findUnique({ where: { tokenHash: digest(match[1]) }, include: { user: { select: { clerkUserId: true } } } });
  if (!key || key.revokedAt || key.expiresAt <= now) throw invalid();
  if (!key.scopes.includes(scope)) throw new HttpError(403, "INSUFFICIENT_SCOPE", "This API key does not allow this action.");
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  // An atomic per-key counter works across workers; revocation is rechecked here.
  const [used] = await db.$queryRaw<{ windowCount: number }[]>`UPDATE "PublicApiKey" SET "windowCount"=CASE WHEN "windowStart"=${window} THEN LEAST("windowCount"+1, ${API_RATE_LIMIT + 1}) ELSE 1 END, "windowStart"=${window}, "lastUsedAt"=${now} WHERE id=${key.id}::uuid AND "revokedAt" IS NULL AND "expiresAt">${now} RETURNING "windowCount"`;
  if (!used) throw invalid();
  if (used.windowCount > API_RATE_LIMIT) throw new HttpError(429, "RATE_LIMITED", "Too many API requests. Retry after the current minute.");
  return { userId: key.user.clerkUserId, keyId: key.id, remaining: API_RATE_LIMIT - used.windowCount, reset: Math.floor(window.getTime() / 1000) + 60 };
}
