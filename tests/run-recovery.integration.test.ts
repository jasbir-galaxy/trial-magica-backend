import { afterAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runs } from "@trigger.dev/sdk";
import { createChat } from "../src/chats/service";
import { createTurn, finishRun, getOwnedRun, saveProgress } from "../src/agent/run-store";
import { reconcileRun } from "../src/agent/dispatch";
import { getDatabase } from "../src/db/client";
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({ runs: { retrieve: vi.fn() }, auth: {}, idempotencyKeys: {}, tasks: {} }));
const db=getDatabase(), user=`recovery_${randomUUID()}`;
async function fixture() {
  vi.stubEnv("TRIAL_INITIAL_CREDITS", "1000000");
  const {chat}=await createChat(user,{title:"Recovery"});
  const row=await createTurn(user,chat.id,{requestId:randomUUID(),text:"Hello",model:"openrouter/free"});
  await db.agentRun.update({where:{id:row.id},data:{status:"running",triggerRunId:"run_fixture",startedAt:new Date(),dispatchAfter:new Date(0)}});
  await saveProgress(row.id,"A saved partial answer",1);
  return getOwnedRun(user,row.id);
}
afterEach(async()=>{
 const owned={user:{clerkUserId:user}};
 await db.creditLedger.deleteMany({where:{account:owned}});await db.creditReservation.deleteMany({where:{account:owned}});await db.creditAccount.deleteMany({where:owned});
 await db.agentRun.deleteMany({where:{chat:owned}});await db.message.deleteMany({where:{chat:owned}});await db.chat.deleteMany({where:owned});await db.user.deleteMany({where:{clerkUserId:user}});vi.resetAllMocks();vi.unstubAllEnvs();
});
afterAll(()=>db.$disconnect());
it("recovers a crashed worker promptly, retains partial text and releases its admission once",async()=>{
 const run=await fixture();vi.mocked(runs.retrieve).mockResolvedValue({isFailed:true,isCancelled:false,isCompleted:true} as never);
 await Promise.all([reconcileRun(run),reconcileRun(run),reconcileRun(run)]);
 const saved=await getOwnedRun(user,run.id);
 expect(saved.status).toBe("failed");expect(saved.assistantMessage.content).toEqual([{type:"text",text:"A saved partial answer"}]);
 expect(saved.error).toMatch(/interrupted/);expect(runs.retrieve).toHaveBeenCalledTimes(1);
 expect(await db.creditReservation.count({where:{runId:run.id,settledAt:null}})).toBe(0);
});
it("keeps a live worker running and rate-limits repeated status reads",async()=>{
 const run=await fixture();vi.mocked(runs.retrieve).mockResolvedValue({isFailed:false,isCancelled:false,isCompleted:false} as never);
 await reconcileRun(run);await reconcileRun(run);
 expect((await getOwnedRun(user,run.id)).status).toBe("running");expect(runs.retrieve).toHaveBeenCalledTimes(1);
});
it("does not turn a transport outage into a failed conversation",async()=>{
 const run=await fixture();vi.mocked(runs.retrieve).mockRejectedValue(new Error("offline"));
 await reconcileRun(run);await reconcileRun(run);
 expect((await getOwnedRun(user,run.id)).status).toBe("running");expect(runs.retrieve).toHaveBeenCalledTimes(1);
});
it("preserves a user's stop when a dead worker is reconciled",async()=>{
 const run=await fixture();await db.agentRun.update({where:{id:run.id},data:{status:"stopping"}});
 vi.mocked(runs.retrieve).mockResolvedValue({isFailed:true,isCancelled:false,isCompleted:true} as never);
 await reconcileRun(await getOwnedRun(user,run.id));expect((await getOwnedRun(user,run.id)).status).toBe("cancelled");
});
it("does not overwrite a concurrent successful finalization",async()=>{
 const run=await fixture();vi.mocked(runs.retrieve).mockImplementation(() => finishRun(run.id,"completed").then(() => ({isFailed:true,isCancelled:false,isCompleted:true})) as unknown as ReturnType<typeof runs.retrieve>);
 await reconcileRun(run);expect((await getOwnedRun(user,run.id)).status).toBe("completed");
});
