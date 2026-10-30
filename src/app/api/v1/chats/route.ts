import { publicRoute } from "@/http/public-route";
import { parseInput, readJson } from "@/http/input";
import { ChatSchema, ChatPageSchema, ChatListQuerySchema } from "@/contracts/chats";
import { PublicCreateChatSchema } from "@/contracts/public-api";
import { createChat, listChats } from "@/chats/service";
const METHODS = ["GET", "POST"];
export function GET(request: Request) { return publicRoute(request, METHODS, "chats:read", async ({ userId }) => Response.json(ChatPageSchema.parse(await listChats(userId, parseInput(ChatListQuerySchema, Object.fromEntries(new URL(request.url).searchParams)))))); }
export function POST(request: Request) { return publicRoute(request, METHODS, "runs:write", async ({ userId }) => { const result = await createChat(userId, parseInput(PublicCreateChatSchema, await readJson(request))); return Response.json(ChatSchema.parse(result.chat), { status: result.created ? 201 : 200, headers: { Location: `/api/v1/chats/${result.chat.id}` } }); }); }
export function OPTIONS(request: Request) { return publicRoute(request, METHODS, "chats:read", async () => new Response(null)); }
