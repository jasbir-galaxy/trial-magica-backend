import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);
import { readUploadEnvironment } from "../src/uploads/config";
try { readUploadEnvironment(); console.log("Upload settings are valid. This checks configuration only; it does not verify provider access."); }
catch { console.error("Upload setup is incomplete. See docs/guides/uploads.md. No secret values were printed."); process.exitCode = 1; }
