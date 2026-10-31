import { request } from "node:https";
import { imageSize } from "image-size";
import { MediaUrlSchema, type ToolOutput } from "../contracts/tools";
import { resolvePublicHost } from "../lib/public-network";
import { logEvent } from "../observability/log";

export const MAX_IMAGE_HEADER_BYTES = 256 * 1024;
const IMAGE_HEADER_TIMEOUT_MS = 5000;
type Dimensions = { width: number; height: number };

// Parse only the three generated raster formats. No SVG/XML, filesystem reads,
// full image decoding, or unbounded body buffering is involved.
function dimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 12) return;
  const supported = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  if (!supported) throw new Error("Unsupported image header");
  try {
    const size = imageSize(bytes);
    if (Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
  } catch { /* A partial JPEG header may need more bytes, within the fixed cap. */ }
}

export async function readImageDimensions(value: string, signal: AbortSignal): Promise<Dimensions | undefined> {
  try {
    const url = new URL(MediaUrlSchema.parse(value));
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) return;
    const address = await resolvePublicHost(url.hostname);
    if (signal.aborted) return;
    return await new Promise<Dimensions | undefined>(resolve => {
      let settled = false, size = 0, nextAttempt = 32;
      const chunks: Buffer[] = [];
      const finish = (result?: Dimensions) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        req.destroy();
        resolve(result);
      };
      const abort = () => finish();
      // Resolve once, pin the public IPv4 address, retain TLS/SNI verification,
      // reject redirects, and use an independent wall-clock/body bound.
      const req = request(url, { method: "GET", agent: false, family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers: { Range: `bytes=0-${MAX_IMAGE_HEADER_BYTES - 1}`, "Accept-Encoding": "identity" },
      }, response => {
        if (![200, 206].includes(response.statusCode ?? 0) || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) { finish(); response.destroy(); return; }
        response.on("error", () => finish());
        response.on("data", (chunk: Buffer) => {
          const part = chunk.subarray(0, MAX_IMAGE_HEADER_BYTES - size);
          chunks.push(part); size += part.length;
          // Exponentially spaced attempts bound parser work even for tiny chunks.
          if (size >= nextAttempt || size >= MAX_IMAGE_HEADER_BYTES) {
            try { const result = dimensions(Buffer.concat(chunks, size)); if (result) { finish(result); response.destroy(); return; } }
            catch { finish(); response.destroy(); return; }
            while (nextAttempt <= size) nextAttempt *= 2;
          }
          if (size >= MAX_IMAGE_HEADER_BYTES) { finish(); response.destroy(); }
        });
        response.on("end", () => { try { finish(dimensions(Buffer.concat(chunks, size))); } catch { finish(); } });
        response.on("aborted", () => finish());
      });
      const timer = setTimeout(abort, IMAGE_HEADER_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      req.on("error", () => finish());
      req.end();
      if (signal.aborted) finish();
    });
  } catch { return; }
}

export async function enrichImageMetadata(output: ToolOutput, signal: AbortSignal, inspect = readImageDimensions): Promise<ToolOutput> {
  const assets = [...output.assets];
  // Four requests at most in flight; result order stays the provider's order.
  for (let start = 0; start < assets.length && !signal.aborted; start += 4) {
    await Promise.all(assets.slice(start, start + 4).map(async (asset, offset) => {
      if (asset.kind !== "image" || (asset.width && asset.height)) return;
      const actual = await inspect(asset.url, signal).catch(() => undefined);
      if (actual) assets[start + offset] = { ...asset, ...actual };
      else logEvent("warn", "Image dimensions unavailable", { code: "IMAGE_METADATA_UNAVAILABLE" });
    }));
  }
  // Inspection is best effort: retain the paid asset/usage even if its CDN is
  // unavailable or the parent was cancelled. Never regenerate to get metadata.
  return { ...output, assets };
}
