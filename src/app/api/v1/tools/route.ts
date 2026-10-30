import { publicRoute } from "@/http/public-route";
import { ToolCatalogSchema } from "@/contracts/public-api";
import { loadToolRegistry } from "@/tools/registry";
export function GET(request: Request) { return publicRoute(request, ["GET"], "chats:read", async () => Response.json(ToolCatalogSchema.parse({ items: [...(await loadToolRegistry()).values()].map(tool => ({ name: tool.name, label: tool.label, description: tool.description, inputSchema: tool.jsonSchema })) }))); }
export function OPTIONS(request: Request) { return publicRoute(request, ["GET"], "chats:read", async () => new Response(null)); }
