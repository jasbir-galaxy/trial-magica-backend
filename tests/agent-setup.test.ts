import { describe, expect, it, vi } from "vitest";
import { AgentConfigurationError, FREE_MODEL, readAgentEnvironment } from "../src/config/agent";
import { checkOpenRouterConnection } from "../src/agent/check-connection";

const env = { OPENROUTER_API_KEY: "test-only-model-key", TRIGGER_SECRET_KEY: "test-only-worker-key", TRIGGER_PROJECT_REF: "proj_test" };
const completion = {
  model: "some-routed-free-model",
  choices: [{ message: { content: "ready" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 1 },
};

describe("agent setup", () => {
  it("reports missing field names without secret values", () => {
    expect(() => readAgentEnvironment({})).toThrow("OPENROUTER_API_KEY, TRIGGER_SECRET_KEY, TRIGGER_PROJECT_REF");
    try {
      readAgentEnvironment({ ...env, OPENROUTER_API_KEY: "private key with whitespace" });
      expect.fail("Expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigurationError);
      expect(String(error)).not.toContain("private key");
    }
  });

  it("uses the free route by default and rejects paid or other model overrides", () => {
    expect(readAgentEnvironment(env).OPENROUTER_MODEL).toBe(FREE_MODEL);
    for (const model of ["openrouter/auto", "paid/model", "some-model:free", ""]) {
      expect(() => readAgentEnvironment({ ...env, OPENROUTER_MODEL: model })).toThrow("OPENROUTER_MODEL");
    }
  });

  it("sends one fixed free request and returns routed-model usage without generated text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion));
    const result = await checkOpenRouterConnection({ env, fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: FREE_MODEL, messages: [{ role: "user", content: "Reply with the single word ready." }], max_tokens: 1_024, stream: false,
    });
    expect(result).toEqual({ requestedModel: FREE_MODEL, actualModel: completion.model, promptTokens: 12, completionTokens: 1 });
  });

  it("allows the free probe to finish after a reasoning model exhausts the old token budget", async () => {
    // The real probe returned HTTP 200, 30 reasoning tokens, 32 completion
    // tokens, and finish_reason=length even though some visible text existed.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { max_tokens: budget } = JSON.parse(String(init?.body)) as { max_tokens: number };
      const truncated = budget <= 32;
      return Response.json({
        ...completion,
        choices: [{ message: { content: "ready" }, finish_reason: truncated ? "length" : "stop" }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: truncated ? 32 : 33,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      });
    });
    await expect(checkOpenRouterConnection({ env, fetch: fetchMock })).resolves.toMatchObject({
      requestedModel: FREE_MODEL, completionTokens: 33,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a paid override before making any request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(checkOpenRouterConnection({ env: { ...env, OPENROUTER_MODEL: "paid/model" }, fetch: fetchMock })).rejects.toThrow("OPENROUTER_MODEL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[401, "AUTHENTICATION"], [403, "AUTHENTICATION"], [429, "RATE_LIMITED"], [503, "UNAVAILABLE"]])("handles HTTP %i without retries or leaking response content", async (status, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("upstream secret", { status: Number(status) }));
    await expect(checkOpenRouterConnection({ env, fetch: fetchMock })).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...completion, choices: [] },
    { ...completion, choices: [{ message: { content: " " }, finish_reason: "stop" }] },
    { ...completion, choices: [{ message: { content: "incomplete" }, finish_reason: "length" }] },
    { error: { message: "private provider details" } },
  ])("rejects empty, failed, or truncated completions", async (body) => {
    await expect(checkOpenRouterConnection({ env, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)) }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not call the provider after cancellation", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(checkOpenRouterConnection({ env, fetch: fetchMock, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a bounded timeout without retrying", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const fetchMock = vi.fn<typeof fetch>();
    try {
      await expect(checkOpenRouterConnection({ env, fetch: fetchMock })).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("forwards cancellation while the network request is pending", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted request")), { once: true });
      controller.abort();
    }));
    await expect(checkOpenRouterConnection({ env, fetch: fetchMock, signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("private request headers"));
    await expect(checkOpenRouterConnection({ env, fetch: fetchMock })).rejects.toMatchObject({
      code: "UNAVAILABLE", message: "The free model service is unavailable. Try the check again later.",
    });
  });
});
