import { CurrentUserSchema } from "@/contracts/current-user";
import { sessionRoute } from "@/http/session-route";

const METHODS = ["GET"];

export function GET(request: Request) {
  return sessionRoute(request, METHODS, (session) =>
    Response.json(CurrentUserSchema.parse({ userId: session.userId })),
  );
}

export function OPTIONS(request: Request) {
  return sessionRoute(request, METHODS, () => new Response(null, { status: 204 }));
}
