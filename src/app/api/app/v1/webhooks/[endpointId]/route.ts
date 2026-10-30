import { z } from "zod";
import { sessionRoute } from "@/http/session-route";
import { parseInput } from "@/http/input";
import { disableWebhook } from "@/webhooks/store";
export function DELETE(request:Request,context:{params:Promise<{endpointId:string}>}) { return sessionRoute(request,["DELETE"],async({userId})=>Response.json(await disableWebhook(userId,parseInput(z.uuid(),(await context.params).endpointId)))); }
export function OPTIONS(request:Request) { return sessionRoute(request,["DELETE"],()=>new Response(null,{status:204})); }
