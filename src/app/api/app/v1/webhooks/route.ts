import { sessionRoute } from "@/http/session-route";
import { parseInput, readJson } from "@/http/input";
import { CreateWebhookSchema } from "@/contracts/webhooks";
import { createWebhook, listWebhooks } from "@/webhooks/store";
const METHODS=["GET","POST"];
export function GET(request:Request) { return sessionRoute(request,METHODS,async({userId})=>Response.json(await listWebhooks(userId))); }
export function POST(request:Request) { return sessionRoute(request,METHODS,async({userId})=>Response.json(await createWebhook(userId,parseInput(CreateWebhookSchema,await readJson(request))),{status:201})); }
export function OPTIONS(request:Request) { return sessionRoute(request,METHODS,()=>new Response(null,{status:204})); }
