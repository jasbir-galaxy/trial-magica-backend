import { sessionRoute } from "@/http/session-route";
import { parseInput, readJson } from "@/http/input";
import { CreateApiKeySchema } from "@/contracts/public-api";
import { createApiKey, listApiKeys } from "@/public-api/keys";
const METHODS = ["GET", "POST"];
export function GET(request: Request) { return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await listApiKeys(userId))); }
export function POST(request: Request) { return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await createApiKey(userId, parseInput(CreateApiKeySchema, await readJson(request))), { status: 201 })); }
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
