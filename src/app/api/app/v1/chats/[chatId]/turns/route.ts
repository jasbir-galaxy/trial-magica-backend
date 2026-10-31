import { logEvent } from "@/observability/log";
import { ChatIdSchema, MAX_TEXT_LENGTH } from "@/contracts/chats";
import { RunStateSchema, SendTurnSchema, SendTurnResultSchema } from "@/contracts/runs";
import { createTurn, getOwnedRun, latestRun } from "@/agent/run-store";
import { dispatchRun, realtimeForRun, reconcileRun } from "@/agent/dispatch";
import { parseInput, readJson } from "@/http/input";
import { sessionRoute } from "@/http/session-route";
import { readAgentEnvironment } from "@/config/agent";
import { HttpError } from "@/http/errors";
const METHODS = ["GET", "POST"];
type Context = { params: Promise<{ chatId: string }> };
export function POST(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const chatId = parseInput(ChatIdSchema, (await context.params).chatId);
    const input = parseInput(SendTurnSchema, await readJson(request, MAX_TEXT_LENGTH * 6 + 1024));
    try { readAgentEnvironment(); } catch { throw new HttpError(503, "SERVICE_UNAVAILABLE", "Chat is not configured yet. Please try again later."); }
    const latest = await latestRun(userId, chatId);
    if (latest) await reconcileRun(latest);
    const run = await createTurn(userId, chatId, input);
    await dispatchRun(run.id);
    const saved = await getOwnedRun(userId, run.id);
    // A realtime outage must not turn an accepted, persisted send into a failure.
    let realtime = null;
    try { realtime = await realtimeForRun(userId, run.id); } catch { logEvent("warn", "Realtime token deferred", { traceId: run.id, runId: run.id, chatId, messageId: run.assistantMessage.id }); }
    return Response.json(SendTurnResultSchema.parse({ run: saved, realtime }), { status: 202 });
  });
}
export function GET(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const chatId = parseInput(ChatIdSchema, (await context.params).chatId);
    const run = await latestRun(userId, chatId);
    if (run) await reconcileRun(run);
    return Response.json(RunStateSchema.parse({ run: run ? await getOwnedRun(userId, run.id) : null }));
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
