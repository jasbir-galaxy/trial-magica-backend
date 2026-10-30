import { createHash } from "node:crypto";

export function hashJson(value: unknown): string {
  function canonical(v: unknown): unknown {
    return Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export const hashText = (value: string) => createHash("sha256").update(value).digest("hex");
