/**
 * Local preview of the HCG Mail 1.0.0 Public Beta 1 product page (for screenshots): the real catalogue and built site,
 * the production settings for HCG Mail, and a stand-in HCGMail.exe of the real size imported through the GitHub-release
 * path and published by a TEST founder. Never production. Prints the origin, then serves until stopped.
 * With --with-macos, also stand-in macOS files (a ZIP holding "HCG Mail.app" and a xar PKG; not the real files, not
 * real sizes) imported as a CI run and published, to preview the page with both platforms.
 *   npx tsx server/test/hcg-mail-preview-server.ts <port-file> [--with-macos]
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { grantFounderException } from "../src/release-exceptions";
import { draftFromRequest, ImportRequestSchema } from "../src/release-import-request";
import { deflateRawSync, deflateSync } from "node:zlib";
import { startHarness } from "./harness";
import { createHash } from "node:crypto";

async function main() {
const root = join(import.meta.dirname, "..", "..");
const request = ImportRequestSchema.parse(JSON.parse(readFileSync(join(root, "release-imports", "hcg-mail-windows-1.0.0-beta.1.json"), "utf8")));
const reg = mkdtempSync(join(tmpdir(), "hcg-mail-preview-"));
writeFileSync(join(reg, "offers.json"), JSON.stringify({ offers: [] }));
writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));
const h = await startHarness({
  withStaticDir: join(root, "dist"),
  env: {
    HCG_CATALOGUE_DIR: join(root, "catalogue"), HCG_STORE_OFFERS_FILE: join(reg, "offers.json"), HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
    HCG_STORE_PAYMENT_PROVIDER: "none", HCG_STORE_PROTECTED_DOWNLOADS: "free-testing-only", HCG_STORE_PUBLISHING: "enabled",
    HCG_STORE_PUBLICATION_PRODUCTS: "hcg-mail", HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "hcg-mail",
    HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish", HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve", HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
  },
});
const ledger = h.authority as TestLedgerAuthority;
const FOUNDER = { sub: "user-founder-preview", email: "founder@example.test", name: "Founder" };
for (const f of ["store.publish", "store.release.approve", "store.release.publish"]) ledger.grant(FOUNDER.sub, "hcg.store", featureEdition(f), "hcg-erp", null);

// Stand-in file of the real size (PE header, zero-filled).
const dir = mkdtempSync(join(tmpdir(), "hcg-mail-preview-files-"));
mkdirSync(join(dir, "files"));
const path = join(dir, "files", "HCGMail.exe");
const head = Buffer.alloc(512);
head.write("MZ", 0, "latin1"); head.writeUInt32LE(0x80, 0x3c); head.write("PE\0\0", 0x80, "latin1");
const fd = openSync(path, "w"); writeSync(fd, head); ftruncateSync(fd, 119023581); closeSync(fd);
const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
const draft = draftFromRequest(request);
draft.artifacts = [{ ...(draft.artifacts[0] as object), sha256: hash }];
const r = await h.app.publishing.importRelease({
  draft, filesDir: join(dir, "files"), passports: {},
  source: { kind: "github-release", repository: "F1r3srp3nt/HCG-Mail", tag: "v1.0.0.0-beta.1-windows-x64", tagCommit: "90726ae21d42f25cdc5ca81d97ab334d5dd5dfce", evidenceRun: 45940124443 },
  requestedEligibility: "public", knownLimitations: request.knownLimitations, authorisedBy: "preview", performedBy: "preview",
});
const founder = await h.signIn(FOUNDER);
await founder.post(`/api/v1/publishing/releases/${r.id}/submit`, {});
grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "preview", authorisedBy: "preview", performedBy: "preview" }, h.clock.now());
for (const [step, body] of [["approve", { eligibility: "public", confirm: "1.0.0-beta.1", current: true }], ["publish", { confirm: "1.0.0-beta.1", current: true }]] as const) {
  const res = await founder.post(`/api/v1/publishing/releases/${r.id}/${step}`, body);
  if (res.status !== 200) throw new Error(`${step}: ${res.status} ${await res.text()}`);
}
if (process.argv.includes("--with-macos")) {
  const commit = "3284671d4be638ac56f5524a42544478b68128d0";
  const runId = 1;
  const mdir = mkdtempSync(join(tmpdir(), "hcg-mail-preview-mac-"));
  mkdirSync(join(mdir, "files"));
  const sha = (b: Buffer, a = "sha256") => createHash(a).update(b).digest("hex");
  const data = Buffer.from("stand-in");
  const comp = deflateRawSync(data); const name = Buffer.from("HCG Mail.app/Contents/Info.plist");
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + comp.length, 16);
  const toc = deflateSync(Buffer.from('<?xml version="1.0"?><xar><toc><signature style="RSA"></signature></toc></xar>'));
  const xh = Buffer.alloc(28); xh.write("xar!", 0, "latin1"); xh.writeUInt16LE(28, 4); xh.writeBigUInt64LE(BigInt(toc.length), 8);
  const files: Record<string, Buffer> = { "HCG Mail.app.zip": Buffer.concat([lh, name, comp, ch, name, end]), "HCG Mail-1.0.0-beta.1-osx-arm64.pkg": Buffer.concat([xh, toc]) };
  for (const [n, b] of Object.entries(files)) writeFileSync(join(mdir, "files", n), b);
  const mac = await h.app.publishing.importRelease({
    draft: {
      release: { productId: "hcg-mail", editionId: "macos-desktop", version: "1.0.0-beta.1", build: "4", channel: "beta", distribution: "free", eligibility: "private", destinations: ["hcg-store"],
        releaseNotes: ["PREVIEW stand-in: HCG Mail 1.0.0-beta.1 for Mac with Apple silicon, public beta. Free."] },
      artifacts: Object.entries(files).map(([n, b]) => ({ fileName: n, platform: "macos", format: n.endsWith(".pkg") ? "pkg" : "zip", sizeBytes: b.length, sha256: sha(b), architectures: ["arm64"], minimumOs: "macOS 11",
        signing: { status: "notarized", evidence: "preview stand-in" }, kind: n.endsWith(".pkg") ? "installer" : "portable-app", sourceCommit: commit, buildProvider: "github-actions", toolchain: "preview" })),
    },
    filesDir: join(mdir, "files"),
    passports: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { artifact: { filename: n, size: b.length, sha256: sha(b), sha512: sha(b, "sha512") }, source: { commit }, build: { run_id: runId } }])) as never,
    source: { repository: "F1r3srp3nt/HCG-Mail", commit, runId }, requestedEligibility: "public", knownLimitations: ["The window needs a display at least 1040 points wide."], authorisedBy: "preview", performedBy: "preview",
  });
  await founder.post(`/api/v1/publishing/releases/${mac.id}/submit`, {});
  grantFounderException(h.db, { releaseId: mac.id, subject: FOUNDER.sub, reason: "preview", authorisedBy: "preview", performedBy: "preview" }, h.clock.now());
  for (const [step, body] of [["approve", { eligibility: "public", confirm: "1.0.0-beta.1", current: true }], ["publish", { confirm: "1.0.0-beta.1", current: true }]] as const) {
    const res = await founder.post(`/api/v1/publishing/releases/${mac.id}/${step}`, body);
    if (res.status !== 200) throw new Error(`macOS ${step}: ${res.status} ${await res.text()}`);
  }
}
writeFileSync(process.argv[2] ?? join(tmpdir(), "hcg-mail-preview.origin"), h.origin);
console.log(`preview ready: ${h.origin} (stand-in sha256 ${hash})`);
}
void main();
