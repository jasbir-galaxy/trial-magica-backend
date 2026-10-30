import { HttpError } from "./errors";
import { requireSession, SessionError } from "../auth/session";
import { withCors } from "./cors";

export function sessionRoute(
  request: Request,
  methods: readonly string[],
  handler: (session: { userId: string }) => Response | Promise<Response>,
) {
  // Preflight exits in withCors before authentication. All returned auth errors
  // receive the same CORS and no-store headers as successful responses.
  return withCors(request, methods, async () => {
    const traceId = crypto.randomUUID();
    try {
      return await handler(await requireSession(request));
    } catch (error) {
      const status = error instanceof SessionError || error instanceof HttpError ? error.status : 500;
      const message = error instanceof SessionError || error instanceof HttpError ? error.message : "Something went wrong. Please try again.";
      if (status >= 500) console.error("Authenticated request failed", {
        traceId, status, ...(error instanceof SessionError ? error.diagnostic : {}),
      });
      return Response.json({
        error: message, message, traceId,
        code: error instanceof HttpError ? error.code : status === 401 ? "UNAUTHORIZED" : status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
      }, { status });
    }
  });
}
