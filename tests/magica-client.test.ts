import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMagicaClient, boundedJson } from "../src/tools/magica-client";
beforeEach(() => { vi.stubEnv("MAGICA_API_KEY", "private-fixture-key"); vi.stubEnv("MAGICA_API_BASE_URL", "https://media.example.com"); });
afterEach(() => vi.unstubAllEnvs());
it("starts and reads the documented API on the configured host without exposing the key", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ runId: "receipt-1" })).mockResolvedValueOnce(Response.json({ id: "receipt-1", nodeType: "crop_image", status: "COMPLETED", creditUsed: 5000, output: { image_url: "https://example.com/crop.png" } }));
  const client = createMagicaClient(fetcher);
  expect(await client.start("crop_image", { image_url: "https://example.com/in.png", crop: { x: 0, y: 0, width: 16, height: 16 } })).toEqual({ runId: "receipt-1" });
  expect((await client.read("receipt-1")).status).toBe("COMPLETED");
  expect(fetcher.mock.calls[0][0]).toBe("https://media.example.com/v1/nodes/crop_image/run");
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer private-fixture-key" });
  expect(fetcher.mock.calls[0][1]?.body).not.toContain("private-fixture-key");
  expect(fetcher.mock.calls[1][0]).toBe("https://media.example.com/v1/nodes/runs/receipt-1");
});
it.each([[401, "AUTH"], [429, "RATE_LIMIT"], [402, "REJECTED"], [500, "UNKNOWN"]])("does not retry POST after HTTP %s", async (status, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-detail", { status: Number(status) }));
  await expect(createMagicaClient(fetcher).start("merge_videos", {})).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("treats a timed-out or malformed POST receipt as unknown without repeating work", async () => {
  for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new DOMException("private", "TimeoutError")), vi.fn<typeof fetch>().mockResolvedValue(Response.json({ other: "invalid" }))]) {
    await expect(createMagicaClient(fetcher).start("gpt_image_2", {})).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it("rejects oversized responses and a receipt for the wrong run", async () => {
  await expect(boundedJson(Response.json({ value: "x".repeat(100) }), 20)).rejects.toThrow();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "other", nodeType: "crop_image", status: "RUNNING", creditUsed: 0, output: null }));
  await expect(createMagicaClient(fetcher).read("wanted")).rejects.toMatchObject({ code: "INVALID_RESULT" });
});

it("estimates the exact node input without dispatching work and treats estimation outages as read failures", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ estimates: [{ microcredits: 650 }] })).mockRejectedValueOnce(new Error("Offline"));
  const client = createMagicaClient(fetcher);
  expect(await client.estimate("gpt_image_2", { prompt: "A circle", quality: "Low" }, "gpt-image-2-text")).toBe(650);
  expect(fetcher.mock.calls[0][0]).toBe("https://media.example.com/v1/nodes/estimate-credits");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ nodes: [{ type: "gpt_image_2", data: { prompt: "A circle", quality: "Low" }, subModelId: "gpt-image-2-text" }] });
  await expect(client.estimate("crop_image", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
