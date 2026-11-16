#!/usr/bin/env node
/**
 * Checks the GitHub Pages artifact BEFORE it is uploaded:
 *   node scripts/verify-pages-artifact.mjs dist
 *
 * - index.html is the built app shell (not the README, not the unbuilt Vite index.html);
 * - every known route has its own HTML page, and 404.html exists (no SPA rewrites on Pages);
 * - the build manifest says production, static (no account service), no fixture data;
 * - the artifact contains no source code, server code or data, markdown, env files, or
 *   distributable binaries (protected files are never published statically).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dir = process.argv[2] ?? "dist";
const problems = [];
const read = (f) => readFileSync(join(dir, f), "utf8");

if (!existsSync(join(dir, "index.html"))) {
  console.error(`✖ ${dir}/index.html does not exist`);
  process.exit(1);
}
const shell = read("index.html");
if (!/<div id="root"><\/div>/.test(shell) || !/src="\/assets\/index-[\w-]+\.js"/.test(shell)) problems.push("index.html is not the built app shell.");
if (/src="\/src\/main\.tsx"/.test(shell)) problems.push("index.html is the unbuilt Vite template.");
if (/npm run dev|HCG Store \(web storefront\)/i.test(shell)) problems.push("index.html contains README text.");
if (!/http-equiv="Content-Security-Policy"/.test(shell)) problems.push("index.html has no Content-Security-Policy meta tag (Pages cannot send headers).");

const products = JSON.parse(readFileSync(join(process.cwd(), process.env.HCG_CATALOGUE_DIR ?? "catalogue", "products.json"), "utf8")).products;
const routes = ["apps", "getting-started", "account", "library", "checkout/return", ...products.flatMap((p) => [`apps/${p.slug}`, `apps/${p.slug}/releases`])];
for (const r of [...routes.map((r) => `${r}.html`), "404.html"]) {
  if (!existsSync(join(dir, r))) problems.push(`missing route page ${r}`);
  else if (read(r) !== shell) problems.push(`${r} differs from index.html`);
}

let manifest = {};
try {
  manifest = JSON.parse(read("hcg-build.json"));
} catch {
  problems.push("hcg-build.json missing or invalid");
}
if (manifest.deployEnv !== "production") problems.push(`deployEnv is ${manifest.deployEnv}, expected production`);
if (manifest.hostingTarget !== "github-pages") problems.push(`hostingTarget is ${manifest.hostingTarget}`);
if (manifest.accountService !== "none") problems.push("a static build must not expect an account service");
if (manifest.fixtureMode) problems.push("fixture data in a production artifact");

const forbidden = /\.(tsx?|mjs|cjs|md|map|deb|ipa|dmg|pkg|exe|msi|msix|apk|zip|appimage|rpm|sqlite|env)$|(^|\/)(\.env.*|package(-lock)?\.json|tsconfig.*\.json)$/i;
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(dir, p)];
  });
const files = walk(dir);
for (const f of files) {
  if (forbidden.test(f)) problems.push(`must not be published: ${f}`);
  if (/^(src|server|catalogue|scripts|e2e|tests|node_modules)\//.test(f)) problems.push(`source directory in artifact: ${f}`);
}

if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  console.error(`\nPages artifact INVALID (${problems.length} problem${problems.length === 1 ? "" : "s"}).`);
  process.exit(1);
}
console.log(`✔ Pages artifact valid: ${files.length} files, ${routes.length} route pages + 404.html, production static build (commit ${manifest.commit ?? "local"}).`);
