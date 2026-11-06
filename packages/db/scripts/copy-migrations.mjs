// Copy SQL migrations next to the compiled runner (dist/migrations) for production builds.
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const src = fileURLToPath(new URL("../src/migrations/", import.meta.url));
const dst = fileURLToPath(new URL("../dist/migrations/", import.meta.url));
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copied migrations → ${dst}`);
