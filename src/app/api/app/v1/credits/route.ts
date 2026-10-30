import { accountForUser } from "@/credits/store";
import { sessionRoute } from "@/http/session-route";
const METHODS = ["GET"];
export function GET(request: Request) { return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await accountForUser(userId))); }
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
