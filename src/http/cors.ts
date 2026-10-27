import { OriginSchema } from "../config/origin";

const ALLOWED_HEADERS = ["authorization", "content-type"];

// CORS controls browser access; protected routes still require authentication.
export async function withCors(
  request: Request,
  methods: readonly string[],
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const headers = new Headers({ Vary: "Origin", "Cache-Control": "no-store" });
  const origin = request.headers.get("Origin");
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers });

  if (origin || request.method === "OPTIONS") {
    const configured = OriginSchema.safeParse(process.env.FRONTEND_ORIGIN);
    if (!configured.success) return fail(503, "Service configuration is unavailable.");
    if (origin !== configured.data) return fail(403, "Origin is not allowed.");
    headers.set("Access-Control-Allow-Origin", configured.data);
  }

  if (request.method === "OPTIONS") {
    headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    const method = request.headers.get("Access-Control-Request-Method");
    if (!method || !methods.includes(method)) return fail(405, "Method is not allowed.");
    const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_HEADERS.includes(header))) {
      return fail(403, "Request headers are not allowed.");
    }
    headers.set("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "));
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return new Response(null, { status: 204, headers });
  }

  const response = await handler();
  headers.forEach((value, name) => response.headers.set(name, value));
  return response;
}
