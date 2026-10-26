import { afterEach, describe, expect, it, vi } from "vitest";
import { withCors } from "../src/http/cors";

const ORIGIN = "https://trial-magica-frontend.vercel.app";
const handle = (request: Request) => withCors(request, ["GET"], () => Response.json({ status: "ok" }));
afterEach(() => vi.unstubAllEnvs());

describe("CORS", () => {
  it("preserves health checks without a browser origin", () => {
    expect(handle(new Request("http://localhost/api/health")).status).toBe(200);
  });
  it("allows only the configured origin", () => {
    vi.stubEnv("FRONTEND_ORIGIN", ORIGIN);
    const response = handle(new Request("http://localhost/api/health", { headers: { Origin: ORIGIN } }));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const denied = handle(new Request("http://localhost/api/health", { headers: { Origin: ORIGIN + ".evil.test" } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
  it("allows authorized preflight headers without executing the handler", () => {
    vi.stubEnv("FRONTEND_ORIGIN", ORIGIN);
    const handler = vi.fn(() => new Response());
    const response = withCors(new Request("http://localhost/api/health", { method: "OPTIONS", headers: {
      Origin: ORIGIN, "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization, Content-Type",
    } }), ["GET"], handler);
    expect(response.status).toBe(204);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", "authorization", 405], ["GET", "x-untrusted", 403],
  ])("rejects unsupported preflight %s / %s", (method, headers, status) => {
    vi.stubEnv("FRONTEND_ORIGIN", ORIGIN);
    expect(handle(new Request("http://localhost/api/health", { method: "OPTIONS", headers: {
      Origin: ORIGIN, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers,
    } })).status).toBe(status);
  });
  it("fails closed when origin configuration is missing", () => {
    vi.stubEnv("FRONTEND_ORIGIN", "");
    expect(handle(new Request("http://localhost/api/health", { headers: { Origin: ORIGIN } })).status).toBe(503);
  });
});
