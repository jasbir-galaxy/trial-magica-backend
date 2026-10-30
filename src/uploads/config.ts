import { z } from "zod";
import { HttpError } from "../http/errors";

const secret = z.string().min(1).refine(value => !/\s/.test(value));
const endpoint = z.url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
});
const Environment = z.object({
  TRANSLOADIT_AUTH_KEY: z.string().regex(/^[a-z0-9]{32}$/), TRANSLOADIT_AUTH_SECRET: secret,
  TRANSLOADIT_PLAN: z.literal("community"),
  UPLOAD_S3_ENDPOINT: endpoint, UPLOAD_S3_REGION: z.string().min(1), UPLOAD_S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  UPLOAD_S3_ACCESS_KEY_ID: secret, UPLOAD_S3_SECRET_ACCESS_KEY: secret,
  UPLOAD_S3_PROVIDER: z.enum(["s3", "backblaze-b2"]).default("s3"),
  UPLOAD_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  UPLOAD_PUBLIC_API_ORIGIN: z.preprocess(value => value === "" ? undefined : value, endpoint.optional()),
}).refine(env => env.UPLOAD_S3_PROVIDER !== "backblaze-b2" || env.UPLOAD_S3_ENDPOINT.replace(/\/$/, "") === `https://s3.${env.UPLOAD_S3_REGION}.backblazeb2.com`, { message: "The B2 endpoint and region must match.", path: ["UPLOAD_S3_ENDPOINT"] });
export function readUploadEnvironment(env: Record<string, string | undefined> = process.env) {
  const result = Environment.safeParse(env);
  if (!result.success) throw new HttpError(503, "UPLOADS_UNAVAILABLE", "File uploads are not configured yet. You can continue chatting without attachments.");
  return result.data;
}
export function uploadsConfigured() { return Environment.safeParse(process.env).success; }
