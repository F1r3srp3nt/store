/**
 * Checks a Dropbox release link BEFORE it is added to catalogue/releases.json.
 *
 *   npm run verify:artifact -- "<dropbox shared link>" [--name <expected file name>] [--sha256 <hex>] [--full]
 *
 * - Normalises the link exactly as the store does (dl=1, rlkey kept).
 * - Requests the first byte only (Range: bytes=0-0) and reports HTTP status, final host,
 *   content type, server-declared file name and total size.
 * - With --full (or --sha256), streams the whole file and computes its SHA-256 locally.
 *
 * It verifies the HTTP response and file identity only. It does NOT test, run, scan or
 * certify the application.
 */
import { createHash } from "node:crypto";
import { toDropboxDownloadUrl } from "../src/downloads/dropbox";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--") && !isValueOf(a));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
function isValueOf(a: string) {
  const i = args.indexOf(a);
  return i > 0 && ["--name", "--sha256"].includes(args[i - 1]!);
}
const expectName = opt("name");
const expectSha = opt("sha256")?.toLowerCase();
const full = args.includes("--full") || Boolean(expectSha);

if (!url) {
  console.error('Usage: npm run verify:artifact -- "<dropbox link>" [--name file.zip] [--sha256 <hex>] [--full]');
  process.exit(2);
}

const r = toDropboxDownloadUrl(url);
if (!r.ok) {
  console.error(`✖ Link rejected (${r.code}): ${r.message}`);
  process.exit(1);
}
console.log(`Normalised download URL: ${r.url}`);
console.log(`File name in link:       ${r.fileName}`);

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`✖ ${m}`);
};

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1]!.trim() : null;
}

const head = await fetch(r.url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
const finalHost = new URL(head.url).hostname;
const type = head.headers.get("content-type");
const name = filenameFrom(head.headers.get("content-disposition"));
const total = Number(/\/(\d+)$/.exec(head.headers.get("content-range") ?? "")?.[1] ?? head.headers.get("content-length") ?? NaN);
await head.body?.cancel();

console.log(`HTTP status:             ${head.status}`);
console.log(`Final host:              ${finalHost}`);
console.log(`Content-Type:            ${type ?? "(none)"}`);
console.log(`Server file name:        ${name ?? "(not declared)"}`);
console.log(`Size (bytes):            ${Number.isFinite(total) ? total : "(not declared)"}`);

if (head.status !== 200 && head.status !== 206) fail(`Unexpected HTTP status ${head.status}.`);
if (type?.includes("text/html")) fail("Response is an HTML page, not a file (link may be private, expired or rate-limited).");
if (!finalHost.endsWith("dropbox.com") && !finalHost.endsWith("dropboxusercontent.com")) fail(`Redirected to unexpected host ${finalHost}.`);
if (expectName && name && name !== expectName) fail(`Server file name "${name}" differs from expected "${expectName}".`);
if (expectName && !name && r.fileName !== expectName) fail(`Link file name "${r.fileName}" differs from expected "${expectName}".`);

if (full && !failed) {
  const res = await fetch(r.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    fail(`Full download failed with HTTP ${res.status}.`);
  } else {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const digest = hash.digest("hex");
    console.log(`Downloaded bytes:        ${bytes}`);
    console.log(`SHA-256:                 ${digest}`);
    if (expectSha && digest !== expectSha) fail("SHA-256 does not match the expected value.");
  }
}

console.log("\nNote: this checks the HTTP response and file identity only. The application itself was not tested.");
if (failed) process.exit(1);
console.log("✔ Artifact response looks like a downloadable file.");
