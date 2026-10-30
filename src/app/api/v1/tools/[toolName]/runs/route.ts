import { publicRoute } from "@/http/public-route";
import { parseInput, readJson } from "@/http/input";
import { DirectToolSchema } from "@/contracts/public-api";
import { MediaToolNameSchema, MAX_TOOL_INPUT_BYTES } from "@/contracts/tools";
import { FREE_CHAT_MODEL } from "@/contracts/runs";
import { submitPublicTurn } from "@/public-api/service";
export function POST(request: Request, context: { params: Promise<{ toolName: string }> }) { return publicRoute(request, ["POST"], "runs:write", async ({ userId }) => { const name = parseInput(MediaToolNameSchema, (await context.params).toolName); const input = parseInput(DirectToolSchema, await readJson(request, MAX_TOOL_INPUT_BYTES + 1024)); const result = await submitPublicTurn(userId, input.chatId, { requestId: input.requestId, text: "Run media tool", model: FREE_CHAT_MODEL }, { name, input: input.input }); return Response.json(result, { status: 202, headers: { Location: `/api/v1/runs/${result.runId}` } }); }); }
export function OPTIONS(request: Request) { return publicRoute(request, ["POST"], "chats:read", async () => new Response(null)); }
