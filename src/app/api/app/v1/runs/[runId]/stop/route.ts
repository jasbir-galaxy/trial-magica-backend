import { RunPayloadSchema, RunSchema } from "@/contracts/runs";
import { stopRun } from "@/agent/run-store";
import { parseInput } from "@/http/input";
import { sessionRoute } from "@/http/session-route";
const METHODS = ["POST"];
export function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const { runId } = parseInput(RunPayloadSchema, await context.params);
    return Response.json(RunSchema.parse(await stopRun(userId, runId)));
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
