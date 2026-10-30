import "server-only";
import { createTurn, getOwnedRun, latestRun } from "../agent/run-store";
import { dispatchRun, reconcileRun } from "../agent/dispatch";
import { readAgentEnvironment } from "../config/agent";
import { HttpError } from "../http/errors";
import { AcceptedRunSchema } from "../contracts/public-api";
import { FREE_CHAT_MODEL, type SendTurn } from "../contracts/runs";
import { loadToolRegistry, prepareTool } from "../tools/registry";
import { MediaToolNameSchema } from "../contracts/tools";
export async function submitPublicTurn(userId: string, chatId: string, input: SendTurn, tool?: { name: string; input: Record<string, unknown> }) {
  try { readAgentEnvironment(); } catch { throw new HttpError(503, "SERVICE_UNAVAILABLE", "Chat is unavailable. Please try again later."); }
  const latest = await latestRun(userId, chatId); if (latest) await reconcileRun(latest);
  const prepared = tool ? prepareTool(await loadToolRegistry(), MediaToolNameSchema.parse(tool.name), tool.input) : undefined;
  const run = await createTurn(userId, chatId, prepared ? { ...input, text: `Run ${prepared.label}`, model: FREE_CHAT_MODEL, planMode: false } : input, prepared);
  await dispatchRun(run.id);
  const saved = await getOwnedRun(userId, run.id);
  return AcceptedRunSchema.parse({ runId: saved.id, chatId: saved.chatId, messageId: saved.userMessage.id, run: saved });
}
