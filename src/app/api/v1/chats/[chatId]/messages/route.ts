import { publicRoute } from "@/http/public-route";
import { parseInput, readJson } from "@/http/input";
import { ChatIdSchema, MessagePageSchema, MessagePageQuerySchema, MAX_TEXT_LENGTH } from "@/contracts/chats";
import { SendTurnSchema } from "@/contracts/runs";
import { listMessages } from "@/chats/service";
import { submitPublicTurn } from "@/public-api/service";
const METHODS = ["GET", "POST"];
type Context = { params: Promise<{ chatId: string }> };
export function GET(request: Request, context: Context) { return publicRoute(request, METHODS, "chats:read", async ({ userId }) => Response.json(MessagePageSchema.parse(await listMessages(userId, parseInput(ChatIdSchema, (await context.params).chatId), parseInput(MessagePageQuerySchema, { order: "desc", ...Object.fromEntries(new URL(request.url).searchParams) }))))); }
export function POST(request: Request, context: Context) { return publicRoute(request, METHODS, "runs:write", async ({ userId }) => { const result = await submitPublicTurn(userId, parseInput(ChatIdSchema, (await context.params).chatId), parseInput(SendTurnSchema, await readJson(request, MAX_TEXT_LENGTH * 6 + 1024))); return Response.json(result, { status: 202, headers: { Location: `/api/v1/runs/${result.runId}` } }); }); }
export function OPTIONS(request: Request) { return publicRoute(request, METHODS, "chats:read", async () => new Response(null)); }
