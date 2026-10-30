import { sessionRoute } from "@/http/session-route";
import { parseInput } from "@/http/input";
import { PageQuerySchema } from "@/contracts/chats";
import { AttachmentPageSchema } from "@/contracts/uploads";
import { listAttachments } from "@/uploads/attachments";
const METHODS = ["GET"];
export function GET(request: Request) {
  return sessionRoute(request, METHODS, async ({ userId }) => Response.json(AttachmentPageSchema.parse(await listAttachments(userId, parseInput(PageQuerySchema, Object.fromEntries(new URL(request.url).searchParams))))));
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
