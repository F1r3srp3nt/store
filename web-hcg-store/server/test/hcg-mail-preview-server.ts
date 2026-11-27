/**
 * Local preview of the HCG Mail 1.0.0 Public Beta 1 product page (for screenshots): the real catalogue and built site,
 * the production settings for HCG Mail, and a stand-in HCGMail.exe of the real size imported through the GitHub-release
 * path and published by a TEST founder. Never production. Prints the origin, then serves until stopped.
 *   npx tsx server/test/hcg-mail-preview-server.ts <port-file>
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { grantFounderException } from "../src/release-exceptions";
import { draftFromRequest, ImportRequestSchema } from "../src/release-import-request";
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
writeFileSync(process.argv[2] ?? join(tmpdir(), "hcg-mail-preview.origin"), h.origin);
console.log(`preview ready: ${h.origin} (stand-in sha256 ${hash})`);
}
void main();
