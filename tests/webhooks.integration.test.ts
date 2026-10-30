import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { getDatabase } from "../src/db/client";
import { createChat } from "../src/chats/service";
import { createTurn, finishRun } from "../src/agent/run-store";
import { claimRun } from "../src/agent/claim-run";
import { createWebhook, listWebhooks, listDeliveries, disableWebhook, recordWebhookEvent } from "../src/webhooks/store";
import { deliverWebhook, MAX_WEBHOOK_ATTEMPTS, recoverWebhookDeliveries } from "../src/webhooks/delivery";
import { verifyWebhook } from "../src/webhooks/signature";
import { prepareTool, registryFromCatalog } from "../src/tools/registry";
import { registerInvocation, settleInvocation } from "../src/tools/store";
import catalog from "./fixtures/magica-catalog.json";
vi.mock("server-only",()=>({}));vi.mock("node:dns/promises",()=>({lookup:vi.fn()}));
const db=getDatabase(), owner=`webhooks_${randomUUID()}`;
beforeEach(()=>{vi.stubEnv("TRIAL_INITIAL_CREDITS","1000000");vi.stubEnv("WEBHOOK_MASTER_KEY",Buffer.alloc(32,42).toString("base64"));vi.mocked(lookup).mockResolvedValue([{address:"1.1.1.1",family:4}] as never);});
afterEach(async()=>{const user={clerkUserId:owner};await db.webhookDelivery.deleteMany({where:{endpoint:{user}}});await db.webhookEvent.deleteMany({where:{user}});await db.webhookEndpoint.deleteMany({where:{user}});await db.creditLedger.deleteMany({where:{account:{user}}});await db.creditReservation.deleteMany({where:{account:{user}}});await db.creditAccount.deleteMany({where:{user}});await db.waitpoint.deleteMany({where:{tool:{run:{user}}}});await db.toolInvocation.deleteMany({where:{run:{user}}});await db.agentRun.deleteMany({where:{user}});await db.message.deleteMany({where:{chat:{user}}});await db.chat.deleteMany({where:{user}});await db.user.deleteMany({where:user});vi.unstubAllEnvs();});
afterAll(()=>db.$disconnect());
const subscribe=()=>createWebhook(owner,{requestId:randomUUID(),url:"https://example.com/events",events:["agent.started","agent.completed","agent.failed","agent.cancelled","tool.completed"]});
async function start(){const {chat}=await createChat(owner,{title:"Webhook test"});const run=await createTurn(owner,chat.id,{requestId:randomUUID(),text:"Hello",model:"openrouter/free"});await claimRun(run.id,"fixture_trigger","agent");return run;}
it("emits state transitions transactionally, once, with safe payloads and paginated ownership",async()=>{
 const subscription=await subscribe(),run=await start();expect(await claimRun(run.id,"again","agent")).toBe(false);
 const tool=await registerInvocation(run.id,"crop",prepareTool(registryFromCatalog(catalog),"crop_image",{image_url:"https://example.com/private.png",crop:{x:0,y:0,width:64,height:64}}));
 await settleInvocation(tool.id,"completed",null,0,{credits:0,assets:[{kind:"image",url:"https://example.com/result.png"}]});await settleInvocation(tool.id,"completed",null,0);
 await Promise.all([finishRun(run.id,"completed"),finishRun(run.id,"failed")]);
 const events=await db.webhookEvent.findMany({where:{runId:run.id}});expect(events.map(e=>e.type).sort()).toEqual(["agent.completed","agent.started","tool.completed"]);expect(JSON.stringify(events)).not.toContain("private.png");
 const page=await listDeliveries(owner,subscription.endpoint.id,{limit:2});expect(page.items).toHaveLength(2);expect(page.hasMore).toBe(true);
 const next=await listDeliveries(owner,subscription.endpoint.id,{limit:2,cursor:page.nextCursor!});expect(next.items).toHaveLength(1);expect(next.items[0].id).not.toBe(page.items[0].id);
 await expect(listDeliveries("foreign",subscription.endpoint.id,{limit:2})).rejects.toMatchObject({status:404});await expect(disableWebhook("foreign",subscription.endpoint.id)).rejects.toMatchObject({status:404});
 expect(JSON.stringify(await listWebhooks(owner))).not.toContain(subscription.secret);
});
it.each(["failed","cancelled"] as const)("records %s and rolls back events with the state transaction",async status=>{
 await subscribe();const run=await start();const row=await db.agentRun.findUniqueOrThrow({where:{id:run.id}});
 await expect(db.$transaction(async tx=>{await recordWebhookEvent(tx,`agent.${status}`,row,status);throw new Error("rollback");})).rejects.toThrow("rollback");
 expect(await db.webhookEvent.count({where:{runId:run.id}})).toBe(1);await finishRun(run.id,status);expect(await db.webhookEvent.count({where:{runId:run.id}})).toBe(2);
});
it("leases concurrent deliveries once, signs stable bytes, and retries using the same event ID",async()=>{
 const subscription=await subscribe();await start();const row=await db.webhookDelivery.findFirstOrThrow({where:{endpointId:subscription.endpoint.id}});const captured:string[]=[];
 const receiver=vi.fn(async(_url:string,body:string,headers:Record<string,string>)=>{expect(verifyWebhook(subscription.secret,headers["X-Magica-Event-Id"],body,headers["X-Magica-Signature"])).toBe(true);captured.push(body);return 429;});
 await Promise.all([deliverWebhook(row.id,receiver),deliverWebhook(row.id,receiver)]);expect(receiver).toHaveBeenCalledTimes(1);
 expect(await db.webhookDelivery.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"pending",attempts:1,responseStatus:429});
 await db.webhookDelivery.update({where:{id:row.id},data:{nextAttemptAt:new Date(0)}});
 await deliverWebhook(row.id,async(url,body,headers)=>{await receiver(url,body,headers);return 204;});expect(captured[1]).toBe(captured[0]);expect(await db.webhookDelivery.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"delivered",attempts:2,responseStatus:204});
 await deliverWebhook(row.id,receiver);expect(receiver).toHaveBeenCalledTimes(2);
});
it.each([302,400,401])("fails permanent HTTP %s without retrying",async code=>{
 const subscription=await subscribe();await start();const row=await db.webhookDelivery.findFirstOrThrow({where:{endpointId:subscription.endpoint.id}});await deliverWebhook(row.id,async()=>code);expect(await db.webhookDelivery.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"failed",responseStatus:code});
});
it("recovers expired leases, bounds retries, and stops disabled endpoints",async()=>{
 const subscription=await subscribe();await start();const row=await db.webhookDelivery.findFirstOrThrow({where:{endpointId:subscription.endpoint.id}});
 await deliverWebhook(row.id,async()=>{throw new Error("timeout");});expect(await db.webhookDelivery.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"pending",attempts:1});
 await db.webhookDelivery.update({where:{id:row.id},data:{status:"delivering",nextAttemptAt:new Date(0),attempts:MAX_WEBHOOK_ATTEMPTS}});await recoverWebhookDeliveries(vi.fn());expect(await db.webhookDelivery.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"failed"});
 await db.webhookDelivery.update({where:{id:row.id},data:{status:"pending",nextAttemptAt:new Date(0),attempts:0}});await disableWebhook(owner,subscription.endpoint.id);const transport=vi.fn();await deliverWebhook(row.id,transport);expect(transport).not.toHaveBeenCalled();expect((await listWebhooks(owner)).items).toHaveLength(0);
});
