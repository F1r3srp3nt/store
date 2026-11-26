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
import { activeException, grantFounderException, revokeException } from "../src/release-exceptions";
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
  // HCG's central grants to the founder: submission, approval and publication (three separate permissions).
  ledger.grant(FOUNDER.sub, "hcg.store", featureEdition("store.publish"), "hcg-erp", null);
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

const who = { authorisedBy: "founder (test)", performedBy: "operator (test)" };
type Client = Awaited<ReturnType<Harness["signIn"]>>;
const post = async (c: Client, path: string, body: unknown = {}) => {
  const res = await c.post(path, body);
  return { status: res.status, body: (await res.json()) as { error?: { code: string }; [k: string]: unknown } };
};
/** The founder-operated path: submit, the operator records the exception, approve, publish. */
async function founderReleases(founder: Client, id: string) {
  expect((await post(founder, `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
  grantFounderException(h.db, { releaseId: id, subject: FOUNDER.sub, reason: "First Windows public prerelease (test)", ...who }, h.clock.now());
  expect((await post(founder, `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1", current: true })).status).toBe(200);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/publish`, { confirm: "0.1.0-beta.1", current: true })).status).toBe(200);
}

describe("HCG Mail for Windows: operator import, separate approval and publication, free testing window", () => {
  it("imports the CI files unchanged as a private draft whose creator is recorded as the CI build; nothing is submitted", async () => {
    const f = importFolder();
    const r = await doImport(f);
    expect(r).toMatchObject({ status: "draft", stage: "uploaded", requestedEligibility: "public", distribution: "free", createdBy: `import:F1r3srp3nt/HCG-Mail#${RUN}`, submittedBy: null, exceptions: [] });
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

  it("keeps submission, approval and publication separate; the CI build is never the second person", async () => {
    const r = await doImport(importFolder());
    const tester = await h.signIn(TESTER);
    const founder = await h.signIn(FOUNDER);
    const approverOnly = await h.signIn(OPERATOR_ONLY);
    // An ordinary account can do none of the three steps.
    expect((await post(tester, `/api/v1/publishing/releases/${r.id}/submit`)).status).toBe(403);
    expect((await post(tester, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).status).toBe(403);
    // Nothing can be approved before a person submits it.
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).body.error?.code).toBe("not_submitted");
    expect((await post(approverOnly, `/api/v1/publishing/releases/${r.id}/submit`)).status).toBe(403); // approval permission does not let you submit
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/submit`)).status).toBe(200);
    // The founder submitted it, so the founder may not approve it: the CI creator does not count as another person.
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).body.error?.code).toBe("separation_of_duties");
    // A second person approves; approval does not include publication.
    expect((await post(approverOnly, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).status).toBe(200);
    expect((await post(approverOnly, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" })).body.error?.code).toBe("not_publication");
    // The founder (the submitter) may not publish either, without an exception.
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" })).body.error?.code).toBe("separation_of_duties");
    ledger.revokeAll(OPERATOR_ONLY.sub);
    expect((await approverOnly.get(`/api/v1/publishing/manager`)).status).toBe(200);
  });

  it("a founder-operated exception covers one person, one release and one exact set of files, is audited, and can be revoked", async () => {
    const r = await doImport(importFolder());
    const founder = await h.signIn(FOUNDER);
    const approverOnly = await h.signIn(OPERATOR_ONLY);
    await post(founder, `/api/v1/publishing/releases/${r.id}/submit`);
    expect(() => grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "x", expectDigest: "0".repeat(64), ...who }, h.clock.now())).toThrow(/not the ones expected/);
    expect(() => grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: " ", ...who }, h.clock.now())).toThrow(/reason/);
    const x = grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "First Windows public prerelease (test)", ...who }, h.clock.now());
    expect(() => grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "again", ...who }, h.clock.now())).toThrow(/already recorded/);
    // It is not a permission: someone without store.release.publish still cannot publish.
    expect((await post(approverOnly, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).status).toBe(200);
    expect((await post(approverOnly, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" })).body.error?.code).toBe("not_publication");
    // Revoked: the founder is back to the ordinary rule.
    revokeException(h.db, x.id, { reason: "test revoke", ...who }, h.clock.now());
    expect(activeException(h.db, r.id, FOUNDER.sub)).toBeNull();
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" })).body.error?.code).toBe("separation_of_duties");
    const y = grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "re-granted (test)", ...who }, h.clock.now());
    const pub = await post(founder, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: "published", submittedBy: FOUNDER.sub, exceptions: [{ id: x.id, revokedAt: expect.any(Number) }, { id: y.id, appliesToCurrentFiles: true }] });
    // Every step is in the hash-chained audit, and the publication names the exception and says it was no independent review.
    const actions = (pub.body.audit as { action: string; actor: string; detail: Record<string, unknown> }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["release.imported", "release.submitted", "release.exception-granted", "release.exception-revoked", "release.approved", "release.published"]));
    const published = (pub.body.audit as { action: string; detail: { governance?: unknown } }[]).find((a) => a.action === "release.published")!;
    expect(published.detail.governance).toMatchObject({ exceptionId: y.id, kind: "founder-operated", independentReview: false });
    expect(h.app.publishing.auditIntact()).toBe(true);
    // The record cannot be altered or deleted, only revoked once.
    expect(() => h.db.exec(`UPDATE release_exceptions SET subject = 'someone-else' WHERE id = '${y.id}'`)).toThrow(/only be revoked/);
    expect(() => h.db.exec("DELETE FROM release_exceptions")).toThrow(/kept/);
  });

  it("an exception stops applying when the files change", async () => {
    const r = await doImport(importFolder());
    const founder = await h.signIn(FOUNDER);
    grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "test", ...who }, h.clock.now());
    expect(activeException(h.db, r.id, FOUNDER.sub)).not.toBeNull();
    h.db.prepare("UPDATE pub_artifacts SET status = 'removed' WHERE id = ?").run(r.artifacts[0]!.id); // as a replacement would
    expect(activeException(h.db, r.id, FOUNDER.sub)).toBeNull();
    await post(founder, `/api/v1/publishing/releases/${r.id}/submit`);
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1" })).body.error?.code).toBe("separation_of_duties");
  });

  it("delivers the free files only while a window is open; terminate stops it at once; nothing else opens and nothing is charged", async () => {
    const r = await doImport(importFolder());
    const founder = await h.signIn(FOUNDER);
    await founderReleases(founder, r.id);
    const tester = await h.signIn(TESTER);
    const access = async (c = tester) => ((await (await c.get("/api/v1/products/hcg-mail/access")).json()) as { editions: { editionId: string; state: string; owned: boolean; offers: unknown[]; checkoutReady: boolean; freeTesting: { endsAt: number } | null; artifacts: { id: string; fileName: string }[] }[] }).editions.find((e) => e.editionId === "windows-desktop")!;

    // Published, but no window yet: not free, not for sale, nothing delivered.
    expect(await access()).toMatchObject({ state: "not-for-sale", artifacts: [], freeTesting: null, offers: [], checkoutReady: false });
    const fileId = r.artifacts[0]!.id;
    expect((await tester.get(`/api/v1/downloads/${fileId}`)).status).toBe(403);

    const now = h.clock.now();
    const w = openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: r.id, period: { anchor: "fixed", startsAt: now, endsAt: now + 30 * 86_400_000 }, authorisedBy: "founder (test)", performedBy: "operator (test)" }, now);
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
    expect(extendWindow(h.db, w.id, { endsAt: now + 60 * 86_400_000 }, { authorisedBy: "founder (test)", performedBy: "operator (test)" }, now).endsAt).toBe(now + 60 * 86_400_000);
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
    const w = openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, period: { anchor: "fixed", startsAt: now, endsAt: now + 1000 }, ...who }, now);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, period: { anchor: "fixed", startsAt: now + 500, endsAt: now + 5000 }, ...who }, now)).toThrow(FreeWindowError);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, period: { anchor: "fixed", startsAt: now, endsAt: now - 1 }, ...who }, now)).toThrow(/end after/);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, period: { anchor: "fixed", startsAt: now, endsAt: now + 400 * 86_400_000 }, ...who }, now)).toThrow(/at most/);
    expect(listWindows(h.db, now + 2000)[0]).toMatchObject({ id: w.id, state: "ended" });
    expect(() => extendWindow(h.db, w.id, { endsAt: now + 9000 }, who, now + 2000)).toThrow(/ended/);
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "ios", releaseId: null, period: { anchor: "fixed", startsAt: now, endsAt: now + 1000 }, authorisedBy: "", performedBy: "x" }, now)).toThrow(/authorised/);
    // The log of changes cannot be rewritten.
    expect(() => h.db.exec("UPDATE free_window_events SET authorised_by = 'x'")).toThrow(/append-only/);
    expect(() => h.db.exec("DELETE FROM free_window_events")).toThrow(/append-only/);
  });

  it("free-testing-only never opens licensed or paid files: a published paid release stays undelivered even for its owner", async () => {
    const f = importFolder();
    const draft = { ...f.draft, release: { ...f.draft.release, distribution: "paid", build: "2" } };
    const r = await h.app.publishing.importRelease({ draft, filesDir: join(f.dir, "files"), passports: passportsOf(f.dir, Object.keys(f.files)), source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN }, requestedEligibility: "public", knownLimitations: [], authorisedBy: "a", performedBy: "b" });
    const founder = await h.signIn(FOUNDER);
    await founderReleases(founder, r.id);
    const now = h.clock.now();
    openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, period: { anchor: "fixed", startsAt: now, endsAt: now + 86_400_000 }, authorisedBy: "a", performedBy: "b" }, now);
    const a = ((await (await founder.get("/api/v1/products/hcg-mail/access")).json()) as { editions: { editionId: string; artifacts: unknown[] }[] }).editions.find((e) => e.editionId === "windows-desktop")!;
    expect(a.artifacts).toEqual([]); // paid release: not free, and licensed downloads are off
    expect((await founder.get(`/api/v1/downloads/${r.artifacts[0]!.id}`)).status).toBe(403);
  });

  it("a 30-day window prepared before publication starts at the moment of publication", async () => {
    const r = await doImport(importFolder());
    const founder = await h.signIn(FOUNDER);
    const tester = await h.signIn(TESTER);
    const DAY = 86_400_000;
    const w = openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: r.id, period: { anchor: "publication", durationMs: 30 * DAY, publishedAt: null }, ...who }, h.clock.now());
    expect(w).toMatchObject({ state: "awaiting-publication", startsAt: null, endsAt: null, durationMs: 30 * DAY, anchor: "publication" });
    // Another window cannot be stacked on it, and it can be lengthened before it starts.
    expect(() => openWindow(h.db, { productId: "hcg-mail", editionId: "windows-desktop", releaseId: null, period: { anchor: "fixed", startsAt: h.clock.now(), endsAt: h.clock.now() + DAY }, ...who }, h.clock.now())).toThrow(/already covers/);
    expect(() => extendWindow(h.db, w.id, { endsAt: h.clock.now() + DAY }, who, h.clock.now())).toThrow(/not started/);
    expect(extendWindow(h.db, w.id, { durationMs: 31 * DAY }, who, h.clock.now()).durationMs).toBe(31 * DAY);
    let current = tester;
    const freeFor = async () => ((await (await current.get("/api/v1/products/hcg-mail/access")).json()) as { editions: { editionId: string; state: string; freeTesting: { endsAt: number } | null }[] }).editions.find((e) => e.editionId === "windows-desktop")!;
    await post(founder, `/api/v1/publishing/releases/${r.id}/submit`);
    grantFounderException(h.db, { releaseId: r.id, subject: FOUNDER.sub, reason: "test", ...who }, h.clock.now());
    await post(founder, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "0.1.0-beta.1", current: true });
    expect((await freeFor()).state).toBe("not-for-sale"); // approved, not published: the window has not started
    h.clock.advance(5 * 86_400); // deployment and publication can happen days later; the testing period is not shortened
    const pub = await post(founder, `/api/v1/publishing/releases/${r.id}/publish`, { confirm: "0.1.0-beta.1" });
    const publishedAt = pub.body.publishedAt as number;
    expect(listWindows(h.db, h.clock.now())[0]).toMatchObject({ id: w.id, state: "open", startsAt: publishedAt, endsAt: publishedAt + 31 * DAY });
    expect(await freeFor()).toMatchObject({ state: "free", freeTesting: { endsAt: publishedAt + 31 * DAY } });
    h.clock.advance(31 * 86_400);
    current = await h.signIn(TESTER); // sessions do not last a month
    expect((await freeFor()).state).toBe("not-for-sale"); // ended by itself; nothing charged
    expect(h.db.prepare("SELECT count(*) AS n FROM purchases").get()).toEqual({ n: 0 });
    const events = (h.db.prepare("SELECT action FROM free_window_events WHERE window_id = ? ORDER BY seq").all(w.id) as { action: string }[]).map((e) => e.action);
    expect(events).toEqual(["window.prepared", "window.extended", "window.started-at-publication"]);
  });
});
