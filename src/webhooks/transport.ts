import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import { WebhookUrlSchema } from "../contracts/webhooks";
const denied = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) denied.addSubnet(address, prefix, "ipv4");
export class WebhookTargetError extends Error {}
export const isPublicAddress = (address: string) => isIPv4(address) && !denied.check(address, "ipv4");
export async function resolveWebhookTarget(value: string) {
  const parsed = WebhookUrlSchema.safeParse(value);
  if (!parsed.success) throw new WebhookTargetError("Use a public HTTPS destination.");
  const url = new URL(parsed.data);
  let timer: ReturnType<typeof setTimeout>;
  const addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 3000); })]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new WebhookTargetError("The destination does not resolve to an allowed public address.");
  return { url, address: addresses[0].address };
}
export type WebhookTransport = (url: string, body: string, headers: Record<string, string>) => Promise<number>;
export const sendWebhook: WebhookTransport = async (value, body, headers) => {
  const { url, address } = await resolveWebhookTarget(value);
  return new Promise<number>((resolve, reject) => {
    // Pin the validated address at connect time; preserve hostname/SNI for TLS.
    // A fresh socket avoids DNS rebinding or stale connection-pool destinations.
    const req = request(url, { method: "POST", agent: false, family: 4,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "User-Agent": "Magica-Trial-Webhooks/1.0" },
    }, response => { const status = response.statusCode ?? 502; response.destroy(); resolve(status); });
    const timer = setTimeout(() => req.destroy(new Error("Delivery timeout")), 10_000);
    req.on("error", reject); req.on("close", () => clearTimeout(timer)); req.end(body);
  });
};
