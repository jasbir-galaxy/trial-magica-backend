import { z } from "zod";
import { sessionRoute } from "@/http/session-route";
import { parseInput } from "@/http/input";
import { PageQuerySchema } from "@/contracts/chats";
import { listDeliveries } from "@/webhooks/store";
export function GET(request:Request,context:{params:Promise<{endpointId:string}>}) { return sessionRoute(request,["GET"],async({userId})=>Response.json(await listDeliveries(userId,parseInput(z.uuid(),(await context.params).endpointId),parseInput(PageQuerySchema,Object.fromEntries(new URL(request.url).searchParams))))); }
export function OPTIONS(request:Request) { return sessionRoute(request,["GET"],()=>new Response(null,{status:204})); }
