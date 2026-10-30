import { ChatIdSchema, ChatSchema, FavoriteChatSchema, DeleteChatResultSchema } from "@/contracts/chats";
import { getChat, favoriteChat, deleteChat } from "@/chats/service";
import { parseInput, readJson } from "@/http/input";
import { sessionRoute } from "@/http/session-route";

const METHODS = ["GET", "PATCH", "DELETE"];
type Context = { params: Promise<{ chatId: string }> };
export function GET(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const chatId = parseInput(ChatIdSchema, (await context.params).chatId);
    return Response.json(ChatSchema.parse(await getChat(userId, chatId)));
  });
}
export function OPTIONS(request: Request) {
  return sessionRoute(request, METHODS, () => new Response(null, { status: 204 }));
}

export function PATCH(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const id = parseInput(ChatIdSchema, (await context.params).chatId);
    const input = parseInput(FavoriteChatSchema, await readJson(request));
    return Response.json(ChatSchema.parse(await favoriteChat(userId, id, input.isFavorite)));
  });
}
export function DELETE(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const id = parseInput(ChatIdSchema, (await context.params).chatId);
    return Response.json(DeleteChatResultSchema.parse(await deleteChat(userId, id)));
  });
}
