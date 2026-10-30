import { writeFileSync, readFileSync } from "node:fs";
import { buildOpenApi } from "../src/public-api/openapi";
const output=JSON.stringify(buildOpenApi(process.env.PUBLIC_API_BASE_URL),null,2)+"\n";
const path="docs/site/openapi.json";
if(process.argv.includes("--check")){if(readFileSync(path,"utf8")!==output)throw new Error("OpenAPI is stale. Run pnpm docs:generate.");}
else writeFileSync(path,output);
