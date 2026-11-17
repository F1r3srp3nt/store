/**
 * Starts the HCG Store server locally against the REAL HCG Connect, with the development client
 * (server/dev/hcg-connect.development.env). `npm run hcg:dev`
 *
 * - Creates `.hcg-dev/secret.key` on first run (32 random bytes, mode 0600, git-ignored), so sealed
 *   sessions survive a restart. It is never printed.
 * - Refuses to start without a built storefront in `dist/` (run `npm run build` first).
 * Tokens stay in the server; the browser gets only an HttpOnly cookie. Nothing here logs a token.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "./hcg-dev-env";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);

const env = loadEnvFile(join(root, "server/dev/hcg-connect.development.env"));
if (!existsSync(join(root, "dist/index.html"))) {
  console.error("No built storefront in dist/. Run `npm run build` first, then `npm run hcg:dev`.");
  process.exit(1);
}
mkdirSync(join(root, ".hcg-dev/data"), { recursive: true, mode: 0o700 });
const keyFile = join(root, ".hcg-dev/secret.key");
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  chmodSync(keyFile, 0o600);
}
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.HCG_STORE_SECRET_KEY = readFileSync(keyFile, "utf8").trim();

console.log("HCG Store (local development, real HCG Connect, development client)");
console.log(`  Open ${env.HCG_STORE_PUBLIC_ORIGIN}/account and choose "Sign in with HCG Connect".`);
console.log("  Purchases and protected downloads are disabled. Stop with Ctrl-C.");
await import("../server/src/main");
