import { sessionRoute } from "@/http/session-route";
import { parseInput, readJson } from "@/http/input";
import { z } from "zod";
import { AttachmentIdListSchema, ResolveAttachmentsSchema } from "@/contracts/uploads";
import { resolveAttachments } from "@/uploads/attachments";
const METHODS = ["POST"];
export function POST(request: Request) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const { ids } = parseInput(z.strictObject({ ids: AttachmentIdListSchema }), await readJson(request));
    return Response.json(ResolveAttachmentsSchema.parse(await resolveAttachments(userId, ids)));
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
