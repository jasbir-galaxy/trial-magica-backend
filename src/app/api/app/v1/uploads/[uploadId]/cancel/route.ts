import { z } from "zod";
import { sessionRoute } from "@/http/session-route";
import { parseInput } from "@/http/input";
import { cancelUpload } from "@/uploads/store";
import { dispatchUpload } from "@/uploads/dispatch";
const METHODS = ["POST"];
export function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const id = parseInput(z.uuid(), (await context.params).uploadId);
    const result = await cancelUpload(userId, id); await dispatchUpload(id); return Response.json(result);
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
