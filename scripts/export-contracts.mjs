import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit export keeps the frontend deploy independent of a sibling checkout.
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/export-contracts.mjs <frontend>/src/generated");
const source = fileURLToPath(new URL("../src/contracts/health.ts", import.meta.url));
await mkdir(resolve(destination), { recursive: true });
await writeFile(resolve(destination, "health.ts"),
  "// Generated from backend src/contracts/health.ts. Do not edit manually.\n" + await readFile(source, "utf8"));
