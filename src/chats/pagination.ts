import { z } from "zod";
import { MAX_CURSOR_LENGTH } from "../contracts/chats";
import { HttpError } from "../http/errors";

const CursorSchema = z.strictObject({
  version: z.literal(1), scope: z.string(), id: z.uuid(), createdAt: z.iso.datetime(),
});
type Boundary = { id: string; createdAt: Date };

export function decodeCursor(value: string | undefined, scope: string): Boundary | undefined {
  if (!value) return undefined;
  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = CursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (decoded.scope !== scope) throw new Error();
    return { id: decoded.id, createdAt: new Date(decoded.createdAt) };
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The page cursor is invalid.");
  }
}

export function makePage<T extends Boundary>(rows: T[], limit: number, scope: string) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    version: 1, scope, id: last.id, createdAt: last.createdAt.toISOString(),
  })).toString("base64url") : null;
  return { items, hasMore, nextCursor };
}
