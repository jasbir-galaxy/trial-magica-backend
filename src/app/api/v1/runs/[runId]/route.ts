import { publicRoute } from "@/http/public-route";
import { parseInput } from "@/http/input";
import { RunPayloadSchema, RunSchema } from "@/contracts/runs";
import { getOwnedRun } from "@/agent/run-store";
import { reconcileRun } from "@/agent/dispatch";
export function GET(request: Request, context: { params: Promise<{ runId: string }> }) { return publicRoute(request, ["GET"], "chats:read", async ({ userId }) => { const { runId } = parseInput(RunPayloadSchema, await context.params); await reconcileRun(await getOwnedRun(userId, runId)); return Response.json(RunSchema.parse(await getOwnedRun(userId, runId))); }); }
export function OPTIONS(request: Request) { return publicRoute(request, ["GET"], "chats:read", async () => new Response(null)); }
