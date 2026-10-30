import { RunPayloadSchema, RunSchema } from "@/contracts/runs";
import { stopRun } from "@/agent/run-store";
import { parseInput } from "@/http/input";
import { publicRoute } from "@/http/public-route";
const METHODS = ["POST"];
export function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return publicRoute(request, METHODS, "runs:write", async ({ userId }) => {
    const { runId } = parseInput(RunPayloadSchema, await context.params);
    return Response.json(RunSchema.parse(await stopRun(userId, runId)));
  });
}
export function OPTIONS(request: Request) { return publicRoute(request, METHODS, "chats:read", async () => new Response(null, { status: 204 })); }
