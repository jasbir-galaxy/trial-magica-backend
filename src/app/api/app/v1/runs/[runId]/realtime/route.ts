import { RealtimeSchema, RunPayloadSchema } from "@/contracts/runs";
import { realtimeForRun } from "@/agent/dispatch";
import { parseInput } from "@/http/input";
import { sessionRoute } from "@/http/session-route";
const METHODS = ["POST"];
export function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const { runId } = parseInput(RunPayloadSchema, await context.params);
    return Response.json(RealtimeSchema.nullable().parse(await realtimeForRun(userId, runId)));
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
