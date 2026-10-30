import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { endpointSecret, webhookSignature, verifyWebhook } from "../src/webhooks/signature";
import { WebhookUrlSchema } from "../src/contracts/webhooks";
import { isPublicAddress, resolveWebhookTarget, sendWebhook } from "../src/webhooks/transport";
vi.mock("node:dns/promises",()=>({lookup:vi.fn()}));
vi.mock("node:https",()=>({request:vi.fn()}));
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});
it("authenticates exact bytes and IDs, rejects replay and tampering, and isolates endpoint secrets",()=>{
 vi.stubEnv("WEBHOOK_MASTER_KEY",Buffer.alloc(32,42).toString("base64"));
 const secret=endpointSecret("one"), body='{"status":"completed"}', signature=webhookSignature(secret,"event",body,1000);
 expect(endpointSecret("one")).toBe(secret);expect(endpointSecret("two")).not.toBe(secret);
 expect(verifyWebhook(secret,"event",body,signature,1300)).toBe(true);
 for(const [id,payload,now] of [["other",body,1000],["event",body+" ",1000],["event",body,1301],["event",body,699]] as const) expect(verifyWebhook(secret,id,payload,signature,now)).toBe(false);
 expect(verifyWebhook(secret,"event",body,"t=1000,v1=bad",1000)).toBe(false);
 vi.stubEnv("WEBHOOK_MASTER_KEY","");expect(()=>endpointSecret("one")).toThrow();
});
it.each(["http://example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://user:pass@example.com", "https://example.com:8443", "https://example.internal", "https://example.com/#fragment"])("rejects unsafe URL %s",url=>expect(WebhookUrlSchema.safeParse(url).success).toBe(false));
it.each(["127.0.0.1","10.1.2.3","172.16.1.2","192.168.1.1","169.254.169.254","100.64.1.1","0.0.0.0","224.0.0.1","::ffff:127.0.0.1","192.0.2.1"])("blocks non-public address %s",ip=>expect(isPublicAddress(ip)).toBe(false));
it("rejects mixed public/private DNS answers and bounds DNS waits",async()=>{
 vi.mocked(lookup).mockResolvedValueOnce([{address:"1.1.1.1",family:4},{address:"127.0.0.1",family:4}] as never);
 await expect(resolveWebhookTarget("https://example.com")).rejects.toThrow("allowed public address");
 vi.useFakeTimers();vi.mocked(lookup).mockReturnValue(new Promise(()=>{}));
 const pending=expect(resolveWebhookTarget("https://example.com")).rejects.toThrow("DNS timeout");
 await vi.advanceTimersByTimeAsync(3000);await pending;
});
it("pins the checked IP while preserving TLS hostname and never follows redirects",async()=>{
 vi.mocked(lookup).mockResolvedValue([{address:"1.1.1.1",family:4}] as never);
 const req=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn()});
 vi.mocked(request).mockImplementation(((url:URL,options:{lookup:(host:string,options:object,callback:(error:null,address:string,family:number)=>void)=>void},callback:(response:{statusCode:number;destroy:()=>void})=>void)=>{
   expect(url.hostname).toBe("example.com");const cb=vi.fn();options.lookup("example.com",{},cb);expect(cb).toHaveBeenCalledWith(null,"1.1.1.1",4);
   queueMicrotask(()=>{callback({statusCode:302,destroy:vi.fn()});req.emit("close");});return req;
 }) as never);
 expect(await sendWebhook("https://example.com/events","{}",{})).toBe(302);expect(lookup).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(1);
});
