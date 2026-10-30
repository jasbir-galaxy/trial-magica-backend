import { sessionRoute } from "@/http/session-route";
import { parseInput, readJson } from "@/http/input";
import { z } from "zod";
import { BindAssemblySchema } from "@/contracts/uploads";
import { getOwnedUpload, uploadDto, bindUpload } from "@/uploads/store";
import { dispatchUpload } from "@/uploads/dispatch";
const METHODS = ["GET", "POST"];
type Context = { params: Promise<{ uploadId: string }> };
export function GET(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => Response.json(await uploadDto(await getOwnedUpload(userId, parseInput(z.uuid(), (await context.params).uploadId)))));
}
export function POST(request: Request, context: Context) {
  return sessionRoute(request, METHODS, async ({ userId }) => {
    const id = parseInput(z.uuid(), (await context.params).uploadId), input = parseInput(BindAssemblySchema, await readJson(request));
    const result = await bindUpload(userId, id, input.assemblyId);
    await dispatchUpload(id);
    return Response.json(result, { status: 202 });
  });
}
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
