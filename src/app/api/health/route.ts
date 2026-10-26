import { HealthResponseSchema } from "@/contracts/health";
import { withCors } from "@/http/cors";

const METHODS = ["GET"];

export function GET(request: Request) {
  return withCors(request, METHODS, () =>
    Response.json(HealthResponseSchema.parse({ status: "ok" })),
  );
}

export function OPTIONS(request: Request) {
  return withCors(request, METHODS, () => new Response(null, { status: 204 }));
}
