import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/export-contracts.mjs <frontend>/src/generated");
const source = fileURLToPath(new URL("../src/contracts/", import.meta.url));
await mkdir(resolve(destination), { recursive: true });
for (const name of (await readdir(source)).filter((name) => name.endsWith(".ts"))) {
  await writeFile(resolve(destination, name),
    `// Generated from backend src/contracts/${name}. Do not edit manually.\n` + await readFile(resolve(source, name), "utf8"));
}
