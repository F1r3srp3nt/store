// @vitest-environment node
/**
 * Free public testing release through the operator import (release-import-cli.ts → publishing.importRelease), against
 * the real catalogue's HCG Mail for Windows edition, with the production settings proposed for it: publishing on,
 * three separate central permissions, HCG_STORE_PROTECTED_DOWNLOADS=free-testing-only, no payment provider.
 * The files are small synthetic Windows files in the exact shape of HCG Mail's CI draft and Release Passports.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { extendWindow, FreeWindowError, listWindows, openWindow, terminateWindow } from "../src/free-windows";
import { exportReleaseRecords } from "../src/release-records";
import { startHarness, type Harness } from "./harness";

const FOUNDER = { sub: "user-founder-test", email: "founder@example.test", name: "Founder" };
const TESTER = { sub: "user-tester-test", email: "tester@example.test", name: "Tester" };
const OPERATOR_ONLY = { sub: "user-approver-only", email: "approver@example.test", name: "Approver only" };
const COMMIT = "8bb1a4f078326da6373962cb81a96f88675bc3f4";
const RUN = 45686343504;
const sha = (b: Buffer, algo = "sha256") => createHash(algo).update(b).digest("hex");

/** A minimal Windows PE file (MZ header pointing at a PE signature). */
function pe(tag: string): Buffer {
  const b = Buffer.alloc(512);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.write(tag, 0x100, "latin1");
  return b;
}
/** A ZIP holding HCGMail.exe (stored portable app). */
function zip(exe: Buffer): Buffer {
  const name = Buffer.from("HCGMail.exe");
  const comp = deflateRawSync(exe);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(exe.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(exe.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(0, 42);
  const cd = Buffer.concat([ch, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length + comp.length, 16);
  return Buffer.concat([lh, name, comp, cd, end]);
}

/** An import folder shaped like HCG Mail's CI output: files/, draft/store-release-draft.json, draft/passports/. */
function importFolder(tamper?: (files: Record<string, Buffer>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hcg-import-"));
  mkdirSync(join(dir, "files"));
  mkdirSync(join(dir, "draft", "passports"), { recursive: true });
  const files: Record<string, Buffer> = {
    "HCGMail-0.1.0-beta.1-win-x64-Setup.exe": pe("x64 setup"),
    "HCGMail-0.1.0-beta.1-win-x64.zip": zip(pe("x64 app")),
    "HCGMail-0.1.0-beta.1-win-arm64-Setup.exe": pe("arm64 setup"),
    "HCGMail-0.1.0-beta.1-win-arm64.zip": zip(pe("arm64 app")),
  };
  const artifacts = Object.entries(files).map(([fileName, bytes]) => {
    const arch = fileName.includes("arm64") ? "arm64" : "x64";
    const installer = fileName.endsWith(".exe");
    return {
      fileName, platform: "windows", format: installer ? "exe" : "zip", sizeBytes: bytes.length, sha256: sha(bytes), architectures: [arch],
      minimumOs: arch === "x64" ? "Windows 10 1607" : "Windows 11",
      signing: { status: "unsigned", evidence: "Get-AuthenticodeSignature: NotSigned", tool: "PowerShell Get-AuthenticodeSignature" },
      kind: installer ? "installer" : "portable-app", package: null, sourceCommit: COMMIT, buildProvider: "github-actions",
      toolchain: "HCG Executable Maker (test)", validationReport: { tool: "HCG Mail windows-prerelease.yml", passed: true, summary: "test" }, replaces: null,
    };
  });
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, "draft", "passports", `${name}.passport.json`), JSON.stringify({
      format: "hcg.release-passport", formatVersion: 1, version: "0.1.0-beta.1",
      source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, branch: "main" }, build: { provider: "github-actions", run_id: RUN },
      artifact: { filename: name, size: bytes.length, sha256: sha(bytes), sha512: sha(bytes, "sha512") },
    }));
  }
  tamper?.(files);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, "files", name), bytes);
  const draft = {
    release: {
      productId: "hcg-mail", editionId: "windows-desktop", version: "0.1.0-beta.1", build: "1", channel: "beta",
      releaseNotes: ["HCG Mail 0.1.0-beta.1 for Windows: public testing prerelease."],
      compatibility: { minimumOs: { windows: "Windows 10 1607 (x64), 11 (ARM64)" }, architectures: ["x64", "arm64"], notes: [] },
      distribution: "free", eligibility: "private", destinations: ["hcg-store"],
    },
    artifacts,
  };
  writeFileSync(join(dir, "draft", "store-release-draft.json"), JSON.stringify(draft));
  return { dir, draft, files };
}

const passportsOf = (dir: string, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(join(dir, "draft", "passports", `${n}.passport.json`), "utf8"))]));

let h: Harness;
let ledger: TestLedgerAuthority;
beforeEach(async () => {
  const reg = mkdtempSync(join(tmpdir(), "hcg-import-registry-"));
  writeFileSync(join(reg, "offers.json"), JSON.stringify({ offers: [] }));
  writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));
  h = await startHarness({
    env: {
      HCG_CATALOGUE_DIR: join(__dirname, "..", "..", "catalogue"),
      HCG_STORE_OFFERS_FILE: join(reg, "offers.json"),
      HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
      HCG_STORE_PAYMENT_PROVIDER: "none",
      HCG_STORE_PROTECTED_DOWNLOADS: "free-testing-only",
      HCG_STORE_PUBLISHING: "enabled",
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
    },
  });
  ledger = h.authority as TestLedgerAuthority;
  // HCG's central grants to the founder: approval and publication (submission happens through the operator import).
  ledger.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.approve"), "hcg-erp", null);
  ledger.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.publish"), "hcg-erp", null);
  // The founder also owns every product (Founder/Owner grant): it must not open anything beyond the free files.
  ledger.grant(FOUNDER.sub, "hcg.mail", "*", "founder-owner", null);
  // Someone who may approve but not publish.
  ledger.grant(OPERATOR_ONLY.sub, "hcg.store", featureEdition("store.release.approve"), "hcg-erp", null);
});
afterEach(async () => h.stop());

const doImport = async (folder: ReturnType<typeof importFolder>) =>
  h.app.publishing.importRelease({
    draft: folder.draft, filesDir: join(folder.dir, "files"), passports: passportsOf(folder.dir, Object.keys(folder.files)),
    source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN }, requestedEligibility: "public",
    knownLimitations: ["Not code-signed: Windows SmartScreen warns."], authorisedBy: "founder (test)", performedBy: "operator (test)",
  });

describe("HCG Mail for Windows: operator import, separate approval and publication, free testing window", () => {
  it("imports the CI files unchanged as a submitted private draft whose creator is the CI build", async () => {
    const f = importFolder();
    const r = await doImport(f);
    expect(r).toMatchObject({ status: "submitted", stage: "awaiting-approval", requestedEligibility: "public", distribution: "free", createdBy: `import:F1r3srp3nt/HCG-Mail#${RUN}` });
    expect(r.approvedEligibility).toBeNull();
    expect(r.knownLimitations).toEqual(["Not code-signed: Windows SmartScreen warns."]);
    expect(r.importedFrom).toMatchObject({ commit: COMMIT, runId: RUN, draftRequestedEligibility: "private", authorisedBy: "founder (test)" });
    expect(r.artifacts.map((a) => [a.fileName, a.status, a.sha256]).sort()).toEqual(Object.entries(f.files).map(([n, b]) => [n, "verified", sha(b)]).sort());
    expect(r.artifacts.find((a) => a.fileName.endsWith("x64-Setup.exe"))!.readiness.label).toMatch(/Unsigned/);
  });

  it("refuses any byte change, a wrong passport, a draft for another commit, and needs no rebuild", async () => {
    await expect(doImport(importFolder((files) => (files["HCGMail-0.1.0-beta.1-win-x64.zip"] = Buffer.concat([files["HCGMail-0.1.0-beta.1-win-x64.zip"]!, Buffer.from("x")]))))).rejects.toThrow(/x64\.zip.*bytes|SHA-256/);
    const g = importFolder();
    writeFileSync(join(g.dir, "draft", "passports", "HCGMail-0.1.0-beta.1-win-arm64.zip.passport.json"), JSON.stringify({ artifact: { filename: "x", size: 1, sha256: "0".repeat(64), sha512: "0" }, source: { commit: COMMIT }, build: { run_id: RUN } }));
    await expect(doImport(g)).rejects.toThrow(/Release Passport does not match/);
    const other = importFolder();
    await expect(h.app.publishing.importRelease({ ...{ draft: other.draft, filesDir: join(other.dir, "files"), passports: passportsOf(other.dir, Object.keys(other.files)) }, source: { repository: "F1r3srp3nt/HCG-Mail", commit: "f".repeat(40), runId: RUN }, requestedEligibility: "public", knownLimitations: [], authorisedBy: "a", performedBy: "b" })).rejects.toThrow(/built from/);
    expect((h.db.prepare("SELECT count(*) AS n FROM pub_releases").get() as { n: number }).n).toBe(0); // nothing half-imported
  });

  it("separates approval and publication: each needs its own central permission, a browser, and never the creator", async () => {
    const r = await doImport(importFolder());
    const tester = await h.signIn(TESTER);
    expect((await tester.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).status).toBe(403);
    const approverOnly = await h.signIn(OPERATOR_ONLY);
    expect((await approverOnly.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).status).toBe(200);
    const denied = await approverOnly.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" });
    expect([denied.status, ((await denied.json()) as { error: { code: string } }).error.code]).toEqual([403, "not_publication"]);
    const founder = await h.signIn(FOUNDER);
    expect((await founder.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1", current: true })).status).toBe(200);
    // Revoking HCG's grant takes effect at once.
    ledger.revokeAll(OPERATOR_ONLY.sub);
    expect((await approverOnly.get(`/api/v1/publishing/manager`)).status).toBe(200);
  });

  it("delivers the free files only while a window is open; terminate stops it at once; nothing else opens and nothing is charged", async () => {
    const r = await doImport(importFolder());
    const founder = await h.signIn(FOUNDER);
    await founder.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1", current: true });
    await founder.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1", current: true });
    const tester = await h.signIn(TESTER);
    const access = async (c = tester) => ((await (await c.get("/api/v1/products/hcg-mail/access")).json()) as { editions: { editionId: string; state: string; owned: boolean; offers: unknown[]; checkoutReady: boolean; freeTesting: { endsAt: number } | null; artifacts: { id: string; fileName: string }[] }[] }).editions.find((e) => e.editionId === "windows-desktop")!;

    // Published, but no window yet: not free, not for sale, nothing delivered.
    expect(await access()).toMatchObject({ state: "not-for-sale", artifacts: [], freeTesting: null, offers: [], checkoutReady: false });
    const fileId = r.artifacts[0]!.id;
    expect((await tester.get(`/api/v1/downloads/${fileId}`)).status).toBe(403);

    const now = h.clock.now();
    const w = openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: r.id, startsAt: now, endsAt: now + 30 * 86_400_000, authorisedBy: "founder (test)", performedBy: "operator (test)" }, now);
    const open = await access();
    expect(open).toMatchObject({ state: "free", owned: false, freeTesting: { endsAt: now + 30 * 86_400_000 }, offers: [], checkoutReady: false });
    expect(open.artifacts.map((a) => a.fileName).sort()).toEqual(r.artifacts.map((a) => a.fileName).sort());
    for (const a of open.artifacts) {
      const dl = await tester.get(`/api/v1/downloads/${a.id}`);
      expect(dl.status).toBe(200);
      expect(sha(Buffer.from(await dl.arrayBuffer()))).toBe(r.artifacts.find((x) => x.id === a.id)!.sha256);
    }
    // Signed out: never.
    expect((await h.anonymous().get(`/api/v1/downloads/${fileId}`)).status).toBe(401);
    // The owner gets exactly the free files, no more (free-testing-only mode).
    expect((await access(founder)).artifacts.map((a) => a.id).sort()).toEqual(open.artifacts.map((a) => a.id).sort());
    // The signed-out product page learns only that it is temporarily free, and until when.
    expect((await access(h.anonymous())).freeTesting).toEqual({ endsAt: now + 30 * 86_400_000 });

    // Extension, then manual termination: delivery stops on the next request.
    expect(extendWindow(h.db, w.id, now + 60 * 86_400_000, { authorisedBy: "founder (test)", performedBy: "operator (test)" }, now).endsAt).toBe(now + 60 * 86_400_000);
    terminateWindow(h.db, w.id, "Testing ended early.", { authorisedBy: "founder (test)", performedBy: "operator (test)" }, h.clock.now());
    expect(await access()).toMatchObject({ state: "not-for-sale", artifacts: [], freeTesting: null });
    expect((await tester.get(`/api/v1/downloads/${fileId}`)).status).toBe(403);
    // No purchase, payment or licence record was ever created for the tester.
    expect(h.db.prepare("SELECT count(*) AS n FROM purchases").get()).toEqual({ n: 0 });

    // The catalogue export is the published release with its limitations; no file location or URL.
    const exported = exportReleaseRecords(h.db, h.clock.now());
    expect(exported.records).toHaveLength(1);
    expect(exported.records[0]).toMatchObject({ productId: "hcg-mail", editionId: "windows-desktop", version: "0.1.0-beta.1", channel: "beta", lifecycle: "published", current: true });
    expect(JSON.stringify(exported)).not.toMatch(/storage|https?:|user-/);
  });

  it("ends by itself at the end time, and refuses windows that overlap, run backwards or last longer than allowed", async () => {
    const now = h.clock.now();
    const who = { authorisedBy: "founder (test)", performedBy: "operator (test)" };
    const w = openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, startsAt: now, endsAt: now + 1000, ...who }, now);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, startsAt: now + 500, endsAt: now + 5000, ...who }, now)).toThrow(FreeWindowError);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, startsAt: now, endsAt: now - 1, ...who }, now)).toThrow(/end after/);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, startsAt: now, endsAt: now + 400 * 86_400_000, ...who }, now)).toThrow(/at most/);
    expect(listWindows(h.db, now + 2000)[0]).toMatchObject({ id: w.id, state: "ended" });
    expect(() => extendWindow(h.db, w.id, now + 9000, who, now + 2000)).toThrow(/ended/);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, startsAt: now, endsAt: now + 1000, authorisedBy: "", performedBy: "x" }, now)).toThrow(/authorised/);
    // The log of changes cannot be rewritten.
    expect(() => h.db.exec("UPDATE free_window_events SET authorised_by = 'x'")).toThrow(/append-only/);
    expect(() => h.db.exec("DELETE FROM free_window_events")).toThrow(/append-only/);
  });

  it("free-testing-only never opens licensed or paid files: a published paid release stays undelivered even for its owner", async () => {
    const f = importFolder();
    const draft = { ...f.draft, release: { ...f.draft.release, distribution: "paid", build: "2" } };
    const r = await h.app.publishing.importRelease({ draft, filesDir: join(f.dir, "files"), passports: passportsOf(f.dir, Object.keys(f.files)), source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN }, requestedEligibility: "public", knownLimitations: [], authorisedBy: "a", performedBy: "b" });
    const founder = await h.signIn(FOUNDER);
    await founder.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" });
    await founder.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" });
    const now = h.clock.now();
    openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, startsAt: now, endsAt: now + 86_400_000, authorisedBy: "a", performedBy: "b" }, now);
    const a = ((await (await founder.get("/api/v1/products/hcg-mail/access")).json()) as { editions: { editionId: string; artifacts: unknown[] }[] }).editions.find((e) => e.editionId === "windows-desktop")!;
    expect(a.artifacts).toEqual([]); // paid release: not free, and licensed downloads are off
    expect((await founder.get(`/api/v1/downloads/${r.artifacts[0]!.id}`)).status).toBe(403);
  });
});
