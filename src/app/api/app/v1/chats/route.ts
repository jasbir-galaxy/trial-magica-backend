import { CHATS_PATH, ChatPageSchema, ChatSchema, CreateChatSchema, ChatListQuerySchema } from "@/contracts/chats";
import { createChat, listChats } from "@/chats/service";
import { parseInput, readJson } from "@/http/input";
import { sessionRoute } from "@/http/session-route";

const METHODS = ["GET", "POST"];
export function POST(request: Request) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const input = parseInput(CreateChatSchema, await readJson(request));
    const result = await createChat(userId, input);
    const chat = ChatSchema.parse(result.chat);
    return Response.json(chat, { status: result.created ? 201 : 200,
      headers: { Location: `${CHATS_PATH}/${chat.id}` } });
  });
}
export function GET(request: Request) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const query = parseInput(ChatListQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(ChatPageSchema.parse(await listChats(userId, query)));
  });
}
export function OPTIONS(request: Request) {
  return sessionRoute(request, METHODS, () => new Response(null, { status: 204 }));
}
