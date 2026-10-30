import { sessionRoute } from "@/http/session-route";
import { parseInput, readJson } from "@/http/input";
import { CreateUploadSchema, SignedUploadSchema } from "@/contracts/uploads";
import { createUpload } from "@/uploads/store";
const METHODS = ["POST"];
export function POST(request: Request) {
  return sessionRoute(request, METHODS, async ({ userId }) => Response.json(SignedUploadSchema.parse(await createUpload(userId, parseInput(CreateUploadSchema, await readJson(request, 8192)))), { status: 201 }));
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
