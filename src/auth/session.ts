import { createClerkClient } from "@clerk/backend";
import { TokenVerificationErrorReason } from "@clerk/backend/errors";
import { z } from "zod";
import { OriginSchema } from "../config/origin";

const AuthConfigSchema = z.object({
  secretKey: z.string().min(1),
  publishableKey: z.string().min(1),
  frontendOrigin: OriginSchema,
});

type SessionDiagnostic = {
  reason: "configuration_invalid" | "verification_failed";
  fields?: string[];
  stage?: "client_initialization" | "token_verification" | "identity_read";
  upstreamStatus?: number;
  verificationReason?: string;
  errorKind?: string;
};

export class SessionError extends Error {
  constructor(readonly status: 401 | 503, readonly diagnostic?: SessionDiagnostic) {
    super(status === 401 ? "Please sign in to continue." : "Sign-in verification is temporarily unavailable. Please try again.");
  }
}

export async function requireSession(request: Request): Promise<{ userId: string }> {
  // This API intentionally accepts bearer sessions only, never cross-origin cookies.
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) throw new SessionError(401);
  const parsed = AuthConfigSchema.safeParse({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    frontendOrigin: process.env.FRONTEND_ORIGIN,
  });
  if (!parsed.success) {
    const names: Record<string, string> = {
      secretKey: "CLERK_SECRET_KEY",
      publishableKey: "CLERK_PUBLISHABLE_KEY or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      frontendOrigin: "FRONTEND_ORIGIN",
    };
    throw new SessionError(503, {
      reason: "configuration_invalid",
      fields: [...new Set(parsed.error.issues.map((issue) => names[String(issue.path[0])]))],
    });
  }

  const { secretKey, publishableKey, frontendOrigin } = parsed.data;
  let stage: SessionDiagnostic["stage"] = "client_initialization";
  try {
    const client = createClerkClient({ secretKey, publishableKey });
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    stage = "token_verification";
    // Next.js can proxy Request in production. Native Request cloning accesses
    // private fields on that proxy and throws. Auth needs metadata only: avoid
    // cloning or consuming the original body, which belongs to the route handler.
    const authRequest = new Request(request.url, { method: request.method, headers });
    const state = await client.authenticateRequest(authRequest, {
      acceptsToken: "session_token",
      authorizedParties: [frontendOrigin],
    });
    if (!state.isAuthenticated) throw new SessionError(401);
    stage = "identity_read";
    const auth = state.toAuth();
    if (!auth?.userId) throw new SessionError(401);
    return { userId: auth.userId };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    // Do not expose SDK exceptions, headers, cookies, or tokens in public errors.
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    const sdkReason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
    const verificationReason = typeof sdkReason === "string" && Object.values(TokenVerificationErrorReason).includes(sdkReason)
      ? sdkReason : "unclassified";
    const errorKind = error instanceof TypeError ? "TypeError"
      : error instanceof RangeError ? "RangeError"
      : error instanceof Error ? "Error" : "non_error_throw";
    throw new SessionError(503, {
      reason: "verification_failed", stage, verificationReason, errorKind,
      ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? { upstreamStatus: status } : {}),
    });
  }
}
