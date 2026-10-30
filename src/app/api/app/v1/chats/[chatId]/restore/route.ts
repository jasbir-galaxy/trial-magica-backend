import { ChatIdSchema, ChatSchema } from "@/contracts/chats";
import { restoreChat } from "@/chats/service";
import { parseInput } from "@/http/input";
import { sessionRoute } from "@/http/session-route";
const METHODS = ["POST"];
type Context = { params: Promise<{ chatId: string }> };
export function POST(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const id = parseInput(ChatIdSchema, (await context.params).chatId);
    return Response.json(ChatSchema.parse(await restoreChat(userId, id)));
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
