import { z } from "zod";
import { sessionRoute } from "@/http/session-route";
import { parseInput } from "@/http/input";
import { revokeApiKey } from "@/public-api/keys";
const METHODS = ["DELETE"];
export function DELETE(request: Request, context: { params: Promise<{ keyId: string }> }) { return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await revokeApiKey(userId, parseInput(z.uuid(), (await context.params).keyId)))); }
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
