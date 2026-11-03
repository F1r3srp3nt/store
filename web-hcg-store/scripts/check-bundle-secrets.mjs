#!/usr/bin/env node
/**
 * Scans a built output directory for credential-like strings. Fails (exit 1) on any finding.
 *   node scripts/check-bundle-secrets.mjs dist
 * Also fails if any value of a secret-looking variable from the build environment or a local
 * .env file appears in the bundle.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "dist");
if (!existsSync(dir)) {
  console.error(`✖ ${dir} does not exist. Build first.`);
  process.exit(1);
}

const PATTERNS = [
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JSON Web Token (e.g. Supabase anon/service key)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Supabase service role reference", /service_role/i],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["OpenAI-style secret key", /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ["AWS access key ID", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Dropbox access token", /\bsl\.[A-Za-z0-9_-]{60,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["client_secret assignment", /client_secret["']?\s*[:=]\s*["'][^"']{8,}/i],
  ["Password assignment", /password["']?\s*[:=]\s*["'][^"']{6,}["']/i],
];

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PRIVATE|SERVICE_ROLE|TOKEN|API_KEY|APIKEY|ACCESS_KEY|CREDENTIAL)/i;
const sensitiveValues = new Set();
for (const [k, v] of Object.entries(process.env)) if (SECRET_NAME.test(k) && v && v.length >= 8) sensitiveValues.add(v);
for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  const p = resolve(f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && SECRET_NAME.test(m[1]) && m[2].replace(/^["']|["']$/g, "").length >= 8) sensitiveValues.add(m[2].replace(/^["']|["']$/g, ""));
  }
}

const TEXT = /\.(js|mjs|css|html|json|txt|map|svg|xml|webmanifest)$|^_headers$|^_redirects$/;
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.test(name)) files.push(p);
  }
};
walk(dir);

const findings = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const [label, re] of PATTERNS) {
    const m = re.exec(content);
    if (m) findings.push(`${file}: ${label} → "${m[0].slice(0, 24)}…"`);
  }
  for (const v of sensitiveValues) if (content.includes(v)) findings.push(`${file}: contains the value of a secret-named environment variable`);
}

if (findings.length) {
  for (const f of findings) console.error(`✖ ${f}`);
  console.error(`\nSecret scan FAILED: ${findings.length} finding(s) in ${dir}`);
  process.exit(1);
}
console.log(`✔ Secret scan passed: ${files.length} text files in ${dir}, ${PATTERNS.length} patterns, ${sensitiveValues.size} environment values checked.`);
