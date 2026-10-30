import { z } from "zod";
import { AgentConfigurationError, readAgentEnvironment } from "./agent";
import { readUploadEnvironment } from "../uploads/config";

const remoteUrl = z.url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) && !url.hostname.endsWith(".localhost");
});
const origin = remoteUrl.refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
});
const database = remoteUrl.refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["postgres:", "postgresql:"].includes(url.protocol)
    && ["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
});
const ProductionEnvironment = z.object({
  DATABASE_URL: database,
  DIRECT_URL: database.optional(),
  DATABASE_URL_UNPOOLED: database.optional(),
  TRIGGER_SECRET_KEY: z.string().regex(/^tr_prod_\S+$/),
  FRONTEND_ORIGIN: origin,
  PUBLIC_API_BASE_URL: origin,
  UPLOAD_PUBLIC_API_ORIGIN: origin,
  CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_\S+$/),
  CLERK_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_\S+$/),
  MAGICA_API_BASE_URL: origin,
  MAGICA_API_KEY: z.string().regex(/^\S+$/),
  WEBHOOK_MASTER_KEY: z.string().refine(value => Buffer.from(value, "base64").length === 32 && Buffer.from(value, "base64").toString("base64") === value),
}).refine(env => URL.canParse(env.PUBLIC_API_BASE_URL) && URL.canParse(env.UPLOAD_PUBLIC_API_ORIGIN)
  && new URL(env.PUBLIC_API_BASE_URL).origin === new URL(env.UPLOAD_PUBLIC_API_ORIGIN).origin, {
  path: ["UPLOAD_PUBLIC_API_ORIGIN"], message: "Must match the canonical backend origin.",
});

/** Deployment diagnostics contain field names only, never supplied values. */
export function deploymentIssues(env: Record<string, string | undefined>): string[] {
  const issues = new Set<string>();
  const result = ProductionEnvironment.safeParse({ ...env, CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  if (!result.success) for (const issue of result.error.issues) issues.add(String(issue.path[0]));
  try { readAgentEnvironment(env); } catch (error) {
    if (!(error instanceof AgentConfigurationError)) throw error;
    for (const field of error.fields) issues.add(field);
  }
  try { readUploadEnvironment(env); } catch { issues.add("UPLOAD_CONFIGURATION"); }
  return [...issues].sort();
}
