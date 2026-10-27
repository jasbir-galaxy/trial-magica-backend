import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, OPTIONS } from "../src/app/api/app/v1/me/route";

const { authenticateRequest } = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ authenticateRequest }) }));
const ORIGIN = "http://localhost:3000";
const request = (authorization?: string) => new Request("http://localhost:3001/api/app/v1/me?userId=forged", {
  headers: { Origin: ORIGIN, ...(authorization ? { Authorization: authorization } : {}) },
});
beforeEach(() => {
  vi.stubEnv("FRONTEND_ORIGIN", ORIGIN);
  vi.stubEnv("CLERK_SECRET_KEY", "test-placeholder");
  vi.stubEnv("CLERK_PUBLISHABLE_KEY", "test-placeholder");
  authenticateRequest.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([undefined, "Basic example", "Bearer", "Bearer one two"])("rejects missing/malformed bearer %s", async (header) => {
  const response = await GET(request(header));
  expect(response.status).toBe(401);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(authenticateRequest).not.toHaveBeenCalled();
});
it("returns only the SDK-verified identity, not client-supplied user IDs", async () => {
  authenticateRequest.mockResolvedValue({ isAuthenticated: true, toAuth: () => ({ userId: "user_verified" }) });
  const response = await GET(request("Bearer test-token"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: "user_verified" });
  expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
    acceptsToken: "session_token", authorizedParties: [ORIGIN],
  });
});
it("rejects a token rejected by Clerk", async () => {
  authenticateRequest.mockResolvedValue({ isAuthenticated: false });
  const response = await GET(request("Bearer rejected-token"));
  expect(response.status).toBe(401);
  expect((await response.json()).code).toBe("UNAUTHORIZED");
});
it("allows preflight without authentication", async () => {
  const response = await OPTIONS(new Request("http://localhost:3001/api/app/v1/me", { method: "OPTIONS", headers: {
    Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization",
  } }));
  expect(response.status).toBe(204);
  expect(authenticateRequest).not.toHaveBeenCalled();
});
it("rejects foreign origins before verification", async () => {
  const response = await GET(new Request("http://localhost:3001/api/app/v1/me", { headers: { Origin: "https://evil.test", Authorization: "Bearer token" } }));
  expect(response.status).toBe(403);
  expect(authenticateRequest).not.toHaveBeenCalled();
});
it("returns a safe retryable failure for a verification outage", async () => {
  authenticateRequest.mockRejectedValue(new Error("secret provider details"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await GET(request("Bearer test-token"));
  expect(response.status).toBe(503);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(await response.text()).not.toContain("secret provider details");
});
it("does not accept cookies in place of bearer credentials", async () => {
  const req = request(); req.headers.set("Cookie", "__session=test-cookie");
  expect((await GET(req)).status).toBe(401);
  expect(authenticateRequest).not.toHaveBeenCalled();
});

it("identifies missing configuration without logging credentials", async () => {
  vi.stubEnv("CLERK_SECRET_KEY", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await GET(request("Bearer private-token"));
  expect(response.status).toBe(503);
  expect(log).toHaveBeenCalledWith("Authenticated request failed", expect.objectContaining({
    reason: "configuration_invalid", fields: ["CLERK_SECRET_KEY"],
  }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
  expect(authenticateRequest).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("CLERK_SECRET_KEY");
});
it("logs verification stage and HTTP status without SDK error details", async () => {
  authenticateRequest.mockRejectedValue(Object.assign(new Error("private-secret"), { status: 401 }));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await GET(request("Bearer private-token"));
  expect(response.status).toBe(503);
  expect(log).toHaveBeenCalledWith("Authenticated request failed", expect.objectContaining({
    reason: "verification_failed", stage: "token_verification", upstreamStatus: 401,
  }));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-secret|private-token/);
});
