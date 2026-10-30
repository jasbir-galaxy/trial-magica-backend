import { z } from "zod";
import { getDatabase } from "@/db/client";
import { verifyUploadWebhook, AssemblySchema } from "@/uploads/provider";
import { bindUpload } from "@/uploads/store";
import { dispatchUpload } from "@/uploads/dispatch";
export async function POST(request: Request) {
  // Verify the exact encoded notification before parsing any provider payload.
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response(null, { status: 415 });
  const reader = request.body?.getReader(); if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 1_000_000) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(value); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const payload = form.get("transloadit"), signature = form.get("signature");
    if (!payload || !signature || !verifyUploadWebhook(payload, signature)) return new Response(null, { status: 401 });
    const receipt = AssemblySchema.parse(JSON.parse(payload));
    const params = z.object({ nonce: z.uuid() }).parse(JSON.parse(receipt.params));
    const row = await getDatabase().uploadBatch.findUnique({ where: { id: params.nonce }, include: { user: { select: { clerkUserId: true } } } });
    if (!row) return new Response(null, { status: 204 });
    // Re-read the provider receipt rather than accepting arbitrary result URLs.
    await bindUpload(row.user.clerkUserId, row.id, receipt.assembly_id);
    await dispatchUpload(row.id);
    return new Response(null, { status: 204 });
  } catch { return new Response(null, { status: 503 }); }
}
