import { logEvent, withLogContext } from "../observability/log";
import { authenticateApiKey } from "../public-api/keys";
import { API_RATE_LIMIT, type ApiScope } from "../contracts/public-api";
import { HttpError } from "./errors";
import { ToolInputError } from "../tools/registry";
export async function publicRoute(request: Request, methods: readonly string[], scope: ApiScope, handler: (context: { userId: string; keyId: string }) => Promise<Response>) {
  const traceId = crypto.randomUUID();
  const headers = new Headers({ "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(", "), "Access-Control-Expose-Headers": "Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Trace-Id", "X-Trace-Id": traceId });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  return withLogContext({ traceId, requestTraceId: traceId }, async () => {
    let response: Response;
    try {
      const context = await authenticateApiKey(request, scope);
      headers.set("X-RateLimit-Limit", String(API_RATE_LIMIT)); headers.set("X-RateLimit-Remaining", String(context.remaining)); headers.set("X-RateLimit-Reset", String(context.reset));
      response = await handler(context);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ToolInputError ? 400 : 500;
      const message = error instanceof HttpError || error instanceof ToolInputError ? error.message : "This request could not be completed. Please try again.";
      const code = error instanceof HttpError ? error.code : status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR";
      if (status >= 500) logEvent("error", "Public API request failed", { traceId, status });
      if (status === 429) headers.set("Retry-After", String(60 - Math.floor(Date.now() / 1000) % 60));
      response = Response.json({ error: message, message, code, traceId }, { status });
    }
    headers.forEach((value, name) => response.headers.set(name, value)); return response;
  });
}
