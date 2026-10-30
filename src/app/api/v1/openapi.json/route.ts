import { buildOpenApi } from "@/public-api/openapi";
export function GET(request:Request) {
 const configured=process.env.PUBLIC_API_BASE_URL;
 const url=configured?new URL(configured).origin:new URL(request.url).origin;
 return Response.json(buildOpenApi(url),{headers:{"Access-Control-Allow-Origin":"*","Cache-Control":"public, max-age=300"}});
}
