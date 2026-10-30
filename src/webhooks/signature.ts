import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors";
export function webhooksConfigured() { return /^[A-Za-z0-9+/]{43}=$/.test(process.env.WEBHOOK_MASTER_KEY ?? ""); }
export function endpointSecret(id: string) {
  if (!webhooksConfigured()) throw new HttpError(503, "WEBHOOKS_UNAVAILABLE", "Webhook configuration is unavailable. Please try again later.");
  // Per-endpoint secrets are domain-separated; neither plaintext nor ciphertext
  // needs to be persisted. Keep the master stable while endpoints are active.
  return `whsec_${createHmac("sha256", Buffer.from(process.env.WEBHOOK_MASTER_KEY!, "base64")).update(`magica-webhook-v1:${id}`).digest("base64url")}`;
}
export function webhookSignature(secret: string, id: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${id}.${body}`).digest("hex")}`;
}
export function verifyWebhook(secret: string, id: string, body: string, signature: string, now = Math.floor(Date.now() / 1000)) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || Math.abs(now - Number(match[1])) > 300) return false;
  const expected = webhookSignature(secret, id, body, Number(match[1])).split("v1=")[1];
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(match[2], "hex"));
}
