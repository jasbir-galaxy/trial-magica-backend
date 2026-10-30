import { creditHistory } from "@/credits/store";
import { PageQuerySchema } from "@/contracts/chats";
import { parseInput } from "@/http/input";
import { sessionRoute } from "@/http/session-route";
const METHODS = ["GET"];
export function GET(request: Request) { return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await creditHistory(userId, parseInput(PageQuerySchema, Object.fromEntries(new URL(request.url).searchParams))))); }
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
