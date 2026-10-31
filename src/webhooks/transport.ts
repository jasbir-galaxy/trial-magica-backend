import { request } from "node:https";
import { PublicTargetError, resolvePublicHost } from "../lib/public-network";
export { isPublicAddress } from "../lib/public-network";
import { WebhookUrlSchema } from "../contracts/webhooks";
export class WebhookTargetError extends Error {}
export async function resolveWebhookTarget(value: string) {
  const parsed = WebhookUrlSchema.safeParse(value);
  if (!parsed.success) throw new WebhookTargetError("Use a public HTTPS destination.");
  const url = new URL(parsed.data);
  try { return { url, address: await resolvePublicHost(url.hostname) }; }
  catch (error) { if (error instanceof PublicTargetError) throw new WebhookTargetError(error.message); throw error; }
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
