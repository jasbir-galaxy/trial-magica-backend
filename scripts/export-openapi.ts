import { writeFileSync, readFileSync } from "node:fs";
import { buildOpenApi } from "../src/public-api/openapi";
// The checked-in documentation targets the submitted deployment. Runtime OpenAPI
// still derives its origin from the request; local exports can override this URL.
const documentedOrigin = process.env.PUBLIC_API_BASE_URL ?? "https://trial-magica-backend.vercel.app";
const output=JSON.stringify(buildOpenApi(documentedOrigin),null,2)+"\n";
const path="docs/site/openapi.json";
if(process.argv.includes("--check")){if(readFileSync(path,"utf8")!==output)throw new Error("OpenAPI is stale. Run pnpm docs:generate.");}
else writeFileSync(path,output);
