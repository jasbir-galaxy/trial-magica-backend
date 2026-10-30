import { z } from "zod";
import { HttpError } from "./errors";

export const MAX_JSON_BODY_BYTES = 4096;
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "BAD_REQUEST", "Please check the request fields and try again.");
  return result.data;
}

export async function readJson(request: Request, maximumBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "BAD_REQUEST", "Provide a valid JSON request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "BAD_REQUEST", "Provide a valid JSON request body.");
  } finally {
    reader.releaseLock();
  }
}
