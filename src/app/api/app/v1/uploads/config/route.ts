import { sessionRoute } from "@/http/session-route";
import { uploadPolicy } from "@/uploads/store";
const METHODS = ["GET"];
export function GET(request: Request) { return sessionRoute(request, METHODS, async () => Response.json(await uploadPolicy())); }
export function OPTIONS(request: Request) { return sessionRoute(request, METHODS, () => new Response(null, { status: 204 })); }
