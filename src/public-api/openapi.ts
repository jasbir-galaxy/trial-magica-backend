import { z } from "zod";
import { ChatSchema, ChatPageSchema, MessagePageSchema, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_CURSOR_LENGTH, ChatSearchSchema, ChatViewSchema } from "../contracts/chats";
import { RunSchema, SendTurnSchema } from "../contracts/runs";
import { ApprovalSchema, ApprovalDecisionSchema } from "../contracts/credits";
import * as api from "../contracts/public-api";
import * as hooks from "../contracts/webhooks";
type Json = Record<string, unknown>;
export function buildOpenApi(server = "http://localhost:3001") {
 const schemas: Record<string, Json> = {};
 function ref(name:string, schema:z.ZodType, io:"input"|"output"="output") {
  const generated=z.toJSONSchema(schema,{io});
  delete generated.$schema;
  // z.json() uses recursive $defs. Keep its references local to this component.
  schemas[name]=JSON.parse(JSON.stringify(generated).replaceAll('"#/$defs/',`"#/components/schemas/${name}/$defs/`));
  return { $ref:`#/components/schemas/${name}` };
 }
 const error=ref("Error",api.ApiErrorSchema), paths:Record<string,Json>={};
 const page=[{name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:MAX_PAGE_SIZE,default:DEFAULT_PAGE_SIZE}},{name:"cursor",in:"query",schema:{type:"string",maxLength:MAX_CURSOR_LENGTH}}];
 const json=(schema:Json)=>({"application/json":{schema}});
 function operation(path:string,method:string,id:string,summary:string,output:z.ZodType,options:{input?:z.ZodType;status?:number;scope?:string;description?:string;query?:Json[];session?:boolean;tag?:string}={}) {
  const parameters=[...Array.from(path.matchAll(/\{(\w+)\}/g),match=>({name:match[1],in:"path",required:true,schema:match[1]==="toolName"?{type:"string",enum:["crop_image","gpt_image_2","merge_videos"]}:{type:"string",format:"uuid"}})),...(options.query??[])];
  const responses:Json={ [options.status??200]: {description:options.status===202?"Durable work accepted. Poll the run URL until terminal or waiting for approval.":"Success",content:json(ref(id+"Response",output))} };
  for(const status of [400,401,402,403,404,409,413,415,429,500,503]) responses[status]={description:status===429?"Rate limited. Respect Retry-After.":"Request could not be completed. Use code and traceId for diagnosis.",content:json(error)};
  paths[path]={...paths[path],[method]:{operationId:id,summary,tags:[options.tag??"Conversations"],description:[options.description,options.scope?`Required API key scope: ${options.scope}.`:undefined].filter(Boolean).join("\n\n"),security:[{[options.session?"SessionBearer":"ApiKeyBearer"]:[]}],parameters,responses,...(options.input?{requestBody:{required:true,content:json(ref(id+"Request",options.input,"input"))}}:{})}};
 }
 operation("/api/v1/chats","get","listChats","List conversations",ChatPageSchema,{scope:"chats:read",query:[...page,{name:"q",in:"query",schema:z.toJSONSchema(ChatSearchSchema)},{name:"view",in:"query",schema:z.toJSONSchema(ChatViewSchema)}]});
 operation("/api/v1/chats","post","createChat","Create a conversation",ChatSchema,{input:api.PublicCreateChatSchema,status:201,scope:"runs:write",description:"A repeated identical requestId returns the original conversation with HTTP 200."});
 (paths["/api/v1/chats"].post as {responses:Json}).responses[200]=(paths["/api/v1/chats"].post as {responses:Json}).responses[201];
 operation("/api/v1/chats/{chatId}","get","getChat","Read a conversation",ChatSchema,{scope:"chats:read"});
 operation("/api/v1/chats/{chatId}/messages","get","listMessages","Read messages",MessagePageSchema,{scope:"chats:read",query:[...page,{name:"order",in:"query",schema:{type:"string",enum:["asc","desc"],default:"desc"}}]});
 operation("/api/v1/chats/{chatId}/messages","post","sendMessage","Send a message",api.AcceptedRunSchema,{input:SendTurnSchema,status:202,scope:"runs:write",description:"Reuse requestId and the identical body after a timeout. Only one active run is allowed per conversation."});
 operation("/api/v1/chat/completions","post","createCompletion","Start a chat-style completion",api.AcceptedRunSchema,{input:api.CompletionSchema,status:202,scope:"runs:write",description:"Asynchronous application API, not an OpenAI streaming compatibility endpoint. Send exactly one new user message. Omit chatId to create a conversation; server-owned history supplies earlier context."});
 operation("/api/v1/runs/{runId}","get","getRun","Read durable run status",RunSchema,{scope:"chats:read",tag:"Runs"});
 operation("/api/v1/runs/{runId}/stop","post","stopRun","Stop a run",RunSchema,{scope:"runs:write",tag:"Runs",description:"Stops future work. Submitted media may finish and settle; partial output remains available."});
 operation("/api/v1/approvals/{approvalId}","post","decideApproval","Answer an approval",ApprovalSchema,{input:ApprovalDecisionSchema,scope:"approvals:write",tag:"Runs",description:"Read the saved approval id and inputHash from the run tool card. Reuse requestId for the same decision; stale or conflicting decisions are rejected."});
 operation("/api/v1/tools","get","listTools","Discover current tool schemas",api.ToolCatalogSchema,{scope:"chats:read",tag:"Tools",description:"Current validated schemas for Crop Image, GPT Image 2 and Merge Videos. Fetch this catalog before constructing tool inputs."});
 operation("/api/v1/tools/{toolName}/runs","post","startTool","Execute a media tool",api.AcceptedRunSchema,{input:api.DirectToolSchema,status:202,scope:"runs:write",tag:"Tools",description:"Runs the selected tool without an LLM call. Inputs are validated against the current catalog and pinned to the run. Media approval and credit rules still apply."});
 operation("/api/app/v1/api-keys","get","listKeys","List active API keys",api.ApiKeyListSchema,{session:true,tag:"Account"});
 operation("/api/app/v1/api-keys","post","createKey","Create an API key",api.CreatedApiKeySchema,{input:api.CreateApiKeySchema,status:201,session:true,tag:"Account",description:"Secret is returned once. If the response is lost, list and revoke that key before creating another. Requires an authenticated application session, not an API key."});
 operation("/api/app/v1/api-keys/{keyId}","delete","revokeKey","Revoke an API key",api.AcknowledgementSchema,{session:true,tag:"Account"});
 operation("/api/app/v1/webhooks","get","listWebhooks","List webhook endpoints",hooks.WebhookEndpointListSchema,{session:true,tag:"Webhooks"});
 operation("/api/app/v1/webhooks","post","createWebhook","Create a webhook endpoint",hooks.CreatedWebhookSchema,{input:hooks.CreateWebhookSchema,status:201,session:true,tag:"Webhooks",description:"Public HTTPS port 443, public IPv4 DNS, no redirects. The signing secret is returned once."});
 operation("/api/app/v1/webhooks/{endpointId}","delete","disableWebhook","Disable a webhook endpoint",api.AcknowledgementSchema,{session:true,tag:"Webhooks",description:"Stops pending deliveries. An in-flight delivery may still arrive."});
 operation("/api/app/v1/webhooks/{endpointId}/deliveries","get","listDeliveries","Read delivery history",hooks.WebhookDeliveryPageSchema,{session:true,tag:"Webhooks",query:page});
 ref("WebhookEvent",hooks.WebhookEventSchema);
 return {openapi:"3.1.0",info:{title:"Magica Trial API",version:"1.0.0",description:"Durable agent conversations and media tools. Runtime schemas are generated from backend Zod contracts."},servers:[{url:server,description:"Trial backend"}],paths,components:{securitySchemes:{ApiKeyBearer:{type:"http",scheme:"bearer",description:"An mgtrial_ API key created in API & webhooks settings."},SessionBearer:{type:"http",scheme:"bearer",bearerFormat:"JWT",description:"Authenticated application session token. API keys cannot manage credentials or subscriptions."}},schemas}};
}
