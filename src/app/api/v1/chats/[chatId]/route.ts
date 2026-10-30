import { publicRoute } from "@/http/public-route";
import { parseInput } from "@/http/input";
import { ChatIdSchema, ChatSchema } from "@/contracts/chats";
import { getChat } from "@/chats/service";
export function GET(request: Request, context: { params: Promise<{ chatId: string }> }) { return publicRoute(request, ["GET"], "chats:read", async ({ userId }) => Response.json(ChatSchema.parse(await getChat(userId, parseInput(ChatIdSchema, (await context.params).chatId))))); }
export function OPTIONS(request: Request) { return publicRoute(request, ["GET"], "chats:read", async () => new Response(null)); }
