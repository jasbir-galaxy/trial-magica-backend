import { afterEach, expect, it, vi } from "vitest";
import { logEvent, runLogContext, withLogContext } from "../src/observability/log";
import { randomUUID } from "node:crypto";
afterEach(() => vi.restoreAllMocks());
it("isolates concurrent traces, retains nested request correlation and strips unsupported data", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const traces = [randomUUID(), randomUUID()];
  await Promise.all(traces.map(traceId => withLogContext({ traceId, requestTraceId: traceId }, async () => {
    await Promise.resolve();
    withLogContext({ invocationId: randomUUID() }, () => logEvent("info", "safe event", {
      status: "running", ...{ authorization: "private-token", input: { prompt: "private prompt" }, error: new Error("private-secret") },
    }));
  })));
  expect(log.mock.calls.map(call => call[1].traceId)).toEqual(traces);
  for (const [, fields] of log.mock.calls) expect(fields).toMatchObject({ requestTraceId: fields.traceId, processId: String(process.pid), invocationId: expect.any(String) });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|authorization|prompt/);
  logEvent("info", "outside"); expect(log.mock.calls.at(-1)?.[1]).not.toHaveProperty("traceId");
});
it("uses the same durable trace and message identifiers after a task restart", () => {
  const row = { id: randomUUID(), chatId: randomUUID(), assistantMessageId: randomUUID() };
  expect(runLogContext(row)).toEqual({ traceId: row.id, runId: row.id, chatId: row.chatId, messageId: row.assistantMessageId });
  expect(runLogContext({ ...row, triggerRunId: "run_retry" })).toMatchObject({ traceId: row.id, triggerRunId: "run_retry" });
});
