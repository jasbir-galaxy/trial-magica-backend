import { publicRoute } from "@/http/public-route";
import { parseInput, readJson } from "@/http/input";
import { CompletionSchema } from "@/contracts/public-api";
import { MAX_TEXT_LENGTH } from "@/contracts/chats";
import { createChat } from "@/chats/service";
import { submitPublicTurn } from "@/public-api/service";
export function POST(request: Request) { return publicRoute(request, ["POST"], "runs:write", async ({ userId }) => {
  const input = parseInput(CompletionSchema, await readJson(request, MAX_TEXT_LENGTH * 6 + 1024));
  const chatId = input.chatId ?? (await createChat(userId, { requestId: input.requestId, title: "API conversation" })).chat.id;
  const result = await submitPublicTurn(userId, chatId, { requestId: input.requestId, text: input.messages[0].content, model: input.model, planMode: input.planMode });
  return Response.json(result, { status: 202, headers: { Location: `/api/v1/runs/${result.runId}` } });
}); }
export function OPTIONS(request: Request) { return publicRoute(request, ["POST"], "runs:write", async () => new Response(null)); }
