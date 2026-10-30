import { z } from "zod";
import { ApprovalDecisionSchema } from "@/contracts/credits";
import { approvalDto, decideApproval, deliverApproval } from "@/approvals/store";
import { triggerApprovals } from "@/approvals/trigger";
import { publicRoute } from "@/http/public-route";
import { parseInput, readJson } from "@/http/input";
const METHODS = ["POST"];
export function POST(request: Request, context: { params: Promise<{ approvalId: string }> }) {
  return publicRoute(request, METHODS, "approvals:write", async ({ userId }) => {
    const { approvalId } = parseInput(z.object({ approvalId: z.uuid() }), await context.params);
    const input = parseInput(ApprovalDecisionSchema, await readJson(request));
    const row = await decideApproval(userId, approvalId, input);
    await deliverApproval(row.id, triggerApprovals.complete);
    return Response.json(approvalDto(row));
  });
}
export function OPTIONS(request: Request) { return publicRoute(request, METHODS, "chats:read", async () => new Response(null, { status: 204 })); }
