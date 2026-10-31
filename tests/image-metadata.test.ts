import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { enrichImageMetadata, MAX_IMAGE_HEADER_BYTES, readImageDimensions } from "../src/tools/image-metadata";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const url = "https://images.example.com/result.png", signal = () => new AbortController().signal;
function png(width: number, height: number) {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20); return bytes;
}
function network(chunks: Buffer[], status = 200, headers = {}, finish = true) {
  vi.mocked(lookup).mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: vi.fn() });
  response.destroy.mockImplementation(() => { response.emit("aborted"); });
  vi.mocked(request).mockImplementation(((target: URL, options: { lookup: (host: string, options: object, cb: (...args: unknown[]) => void) => void }, callback: (value: typeof response) => void) => {
    expect(target.hostname).toBe("images.example.com");
    const cb = vi.fn(); options.lookup(target.hostname, {}, cb); expect(cb).toHaveBeenCalledWith(null, "1.1.1.1", 4);
    queueMicrotask(() => { callback(response); for (const chunk of chunks) response.emit("data", chunk); if (finish) response.emit("end"); });
    return req;
  }) as never);
  return { req, response };
}
it("reads actual PNG dimensions from partial chunks and closes the connection early", async () => {
  const bytes = png(1254,1254), { req } = network([bytes.subarray(0,10), bytes.subarray(10)]);
  expect(await readImageDimensions(url, signal())).toEqual({ width: 1254, height: 1254 });
  expect(req.destroy).toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { Range: `bytes=0-${MAX_IMAGE_HEADER_BYTES-1}`, "Accept-Encoding": "identity" } }), expect.any(Function));
});
it.each([302, 401, 429, 500])("does not follow redirects or retry HTTP %s", async status => {
  network([png(10,10)], status); expect(await readImageDimensions(url, signal())).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
});
it("rejects private DNS answers before making a request", async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
  expect(await readImageDimensions(url, signal())).toBeUndefined(); expect(request).not.toHaveBeenCalled();
});
it("bounds body bytes and rejects unsupported or encoded content", async () => {
  const bytes = Buffer.alloc(MAX_IMAGE_HEADER_BYTES + 1); bytes.set([0xff,0xd8,0xff]);
  const { req } = network([bytes], 200, {}, false);
  expect(await readImageDimensions(url, signal())).toBeUndefined(); expect(req.destroy).toHaveBeenCalled();
  network([Buffer.from("<svg width='1'/>")]); expect(await readImageDimensions(url, signal())).toBeUndefined();
  network([png(10,10)],200,{ "content-encoding": "gzip" }); expect(await readImageDimensions(url, signal())).toBeUndefined();
});
it("ends an idle download on its deadline or cancellation", async () => {
  vi.useFakeTimers(); network([],200,{},false);
  const pending = readImageDimensions(url, signal()); await vi.advanceTimersByTimeAsync(5000); expect(await pending).toBeUndefined();
  const controller = new AbortController(); const { req } = network([],200,{},false);
  const cancelled = readImageDimensions(url, controller.signal); await vi.advanceTimersByTimeAsync(1); controller.abort();
  expect(await cancelled).toBeUndefined(); expect(req.destroy).toHaveBeenCalled();
});
it("keeps paid assets and credits on inspection failure and preserves asset order", async () => {
  const output = { assets: [1,2,3].map(i => ({kind:"image" as const,url:`https://images.example.com/${i}.png`})), credits: 7644 };
  const inspect = vi.fn().mockResolvedValueOnce({ width: 1254, height: 1254 }).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ width: 512, height: 512 });
  expect(await enrichImageMetadata(output, signal(), inspect)).toEqual({ ...output, assets: [{...output.assets[0],width:1254,height:1254},output.assets[1],{...output.assets[2],width:512,height:512}] });
  expect(output.assets[0]).not.toHaveProperty("width");
});
