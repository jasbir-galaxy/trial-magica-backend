import { ChatIdSchema, MessagePageSchema, MessagePageQuerySchema } from "@/contracts/chats";
import { listMessages } from "@/chats/service";
import { parseInput } from "@/http/input";
import { sessionRoute } from "@/http/session-route";

const METHODS = ["GET"];
type Context = { params: Promise<{ chatId: string }> };
export function GET(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const chatId = parseInput(ChatIdSchema, (await context.params).chatId);
    const query = parseInput(MessagePageQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(MessagePageSchema.parse(await listMessages(userId, chatId, query)));
  });
}
export function OPTIONS(request: Request) {
  return sessionRoute(request, METHODS, () => new Response(null, { status: 204 }));
}
