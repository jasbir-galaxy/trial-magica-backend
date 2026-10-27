import { createClerkClient } from "@clerk/backend";
import { z } from "zod";
import { OriginSchema } from "../config/origin";

const AuthConfigSchema = z.object({
  secretKey: z.string().min(1),
  publishableKey: z.string().min(1),
  frontendOrigin: OriginSchema,
});

export class SessionError extends Error {
  constructor(readonly status: 401 | 503) {
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
  if (!parsed.success) throw new SessionError(503);

  const { secretKey, publishableKey, frontendOrigin } = parsed.data;
  try {
    const client = createClerkClient({ secretKey, publishableKey });
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    const state = await client.authenticateRequest(new Request(request, { headers }), {
      acceptsToken: "session_token",
      authorizedParties: [frontendOrigin],
    });
    if (!state.isAuthenticated) throw new SessionError(401);
    const auth = state.toAuth();
    if (!auth?.userId) throw new SessionError(401);
    return { userId: auth.userId };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    // Do not expose SDK exceptions, headers, cookies, or tokens in public errors.
    throw new SessionError(503);
  }
}
