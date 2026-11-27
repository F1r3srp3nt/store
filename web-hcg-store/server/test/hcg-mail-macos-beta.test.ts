// @vitest-environment node
/**
 * HCG Mail 1.0.0-beta.1 for macOS (Apple silicon), next to the published Windows x64 release of the same product and
 * version, with the production settings (HCG Mail only; free; no account; no payment provider):
 *   - the macOS files come from HCG Mail's CI run as a ci-run import: its HCG Store draft (shaped exactly as HCG Mail's
 *     macos-evidence.py writes it) and a Release Passport per file;
 *   - the committed request's reviewed changes: release notes (the edition is permanently free, not "free during
 *     testing"), Store-verified notarization, and two description fields the run's draft writes in another shape;
 *   - files HCG Store rejected earlier are refused by SHA-256, whatever their name or route.
 * The files are small synthetic stand-ins (a ZIP holding "HCG Mail.app", a xar package), never the real ones.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { grantFounderException as grantException } from "../src/release-exceptions";
import { draftFromRequest, ImportRequestSchema, REJECTED_SHA256, refuseRejected, withReviewedChanges, type ImportDraft } from "../src/release-import-request";
import { startHarness, type Harness } from "./harness";

const FOUNDER = { sub: "user-founder-test", email: "founder@example.test", name: "Founder" };
const sha = (b: Buffer, algo = "sha256") => createHash(algo).update(b).digest("hex");
const IMPORTS = join(__dirname, "..", "..", "release-imports");
const WINDOWS = ImportRequestSchema.parse(JSON.parse(readFileSync(join(IMPORTS, "hcg-mail-windows-1.0.0-beta.1.json"), "utf8")));
const COMMIT = "3284671d4be638ac56f5524a42544478b68128d0";
const RUN = 45961684897;
const ZIP = "HCG Mail.app.zip";
const PKG = "HCG Mail-1.0.0-beta.1-osx-arm64.pkg";

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A minimal signed-looking xar archive (header + zlib table of contents with a <signature>). */
function xar(): Buffer {
  const toc = deflateSync(Buffer.from('<?xml version="1.0"?><xar><toc><signature style="RSA"></signature><file id="1"><name>Distribution</name></file></toc></xar>'));
  const head = Buffer.alloc(28);
  head.write("xar!", 0, "latin1"); head.writeUInt16BE(28, 4); head.writeUInt16BE(1, 6);
  // HCG Store reads the header fields little-endian; write them so its reader finds the table of contents.
  head.writeUInt16LE(28, 4); head.writeBigUInt64LE(BigInt(toc.length), 8); head.writeBigUInt64LE(BigInt(toc.length * 4), 16); head.writeUInt32BE(1, 24);
  return Buffer.concat([head, toc, Buffer.from("payload")]);
}

/** What HCG Mail's macos-evidence.py writes (store-release-draft.json and the passports), for these bytes. */
function macRun() {
  const files: Record<string, Buffer> = {
    [ZIP]: zip([{ name: "HCG Mail.app/Contents/Info.plist", data: Buffer.from("<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0-beta.1</string></dict></plist>") },
      { name: "HCG Mail.app/Contents/MacOS/HCGMail", data: Buffer.from("\xcf\xfa\xed\xfe arm64 stand-in", "latin1") },
      { name: "HCG Mail.app/Contents/_CodeSignature/CodeResources", data: Buffer.from("<plist/>") }]),
    [PKG]: xar(),
  };
  const dir = mkdtempSync(join(tmpdir(), "hcg-mail-macos-"));
  mkdirSync(join(dir, "files"));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, "files", n), b);
  const longMin = "macOS 11 or later (the app's LSMinimumSystemVersion), on .NET 10's supported macOS versions; Apple silicon";
  const draft: ImportDraft = {
    release: {
      productId: "hcg-mail", editionId: "macos-desktop", version: "1.0.0-beta.1", build: "4", channel: "beta",
      releaseNotes: [
        "HCG Mail 1.0.0-beta.1 for Mac: public testing prerelease, free during testing (temporary; not a permanent free price).",
        "Signed with HCG's Developer ID and notarized by Apple. Installer package for /Applications, or the app as a ZIP.",
      ],
      compatibility: { minimumOs: { macos: "macOS 11.0" }, architectures: ["arm64"], notes: ["Verified on macOS 15 (arm64)."] },
      distribution: "free", eligibility: "private", destinations: ["hcg-store"],
    },
    artifacts: Object.entries(files).map(([n, b]) => ({
      fileName: n, platform: "macos", format: n.endsWith(".pkg") ? "pkg" : "zip", sizeBytes: b.length, sha256: sha(b), architectures: ["arm64"], minimumOs: longMin,
      signing: { status: "signed", evidence: "codesign: Developer ID Application: Example (TEAMID1234), hardened runtime, secure timestamp; notarytool: 0000 Accepted; stapled" },
      kind: n.endsWith(".pkg") ? "installer" : "portable-app", package: "com.hakmicapitalgroup.hcgmail", sourceCommit: COMMIT, buildProvider: "github-actions",
      toolchain: "HCG Executable Maker engine; signed on macOS 15.5 (arm64)",
    })),
  };
  const passports = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, {
    artifact: { filename: n, size: b.length, sha256: sha(b), sha512: sha(b, "sha512") }, source: { commit: COMMIT }, build: { run_id: RUN },
  }])) as never;
  return { dir, files, draft, passports };
}

/** The import request HCG Store would commit for it (expect.sha256 pins the bytes). */
const request = (run: ReturnType<typeof macRun>, over: Record<string, unknown> = {}) => ImportRequestSchema.parse({
  format: "hcg.store.release-import/1",
  source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN, filesArtifact: "hcg-mail-macos-1.0.0-beta.1", draftArtifact: "hcg-mail-macos-release-manifest" },
  expect: { productId: "hcg-mail", editionId: "macos-desktop", version: "1.0.0-beta.1", build: "4", channel: "beta", distribution: "free", platform: "macos", files: 2,
    sha256: Object.fromEntries(Object.entries(run.files).map(([n, b]) => [n, sha(b)])) },
  requestedEligibility: "public",
  knownLimitations: ["IMAP and SMTP only; Microsoft and Google sign-in are not part of the Public Beta."],
  reviewedReleaseNotes: ["HCG Mail 1.0.0-beta.1 for Mac with Apple silicon: public beta. Free.", "Signed with HCG's Developer ID and notarized by Apple. Installer package, or the app as a ZIP."],
  storeVerifiedSigning: Object.fromEntries(Object.keys(run.files).map((n) => [n, { status: "notarized", evidence: "HCG Store hcg-mail-macos-evidence (test): stapled ticket; Gatekeeper accepted the quarantined download as Notarized Developer ID." }])),
  reviewedFileFields: Object.fromEntries(Object.keys(run.files).map((n) => [n, { minimumOs: "macOS 11", package: null }])),
  ...over,
});

const ENV = {
  HCG_CATALOGUE_DIR: join(__dirname, "..", "..", "catalogue"),
  HCG_STORE_PAYMENT_PROVIDER: "none",
  HCG_STORE_PROTECTED_DOWNLOADS: "free-testing-only",
  HCG_STORE_PUBLISHING: "enabled",
  HCG_STORE_PUBLICATION_PRODUCTS: "hcg-mail",
  HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "hcg-mail",
  HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
  HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
  HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
};

let h: Harness;
async function start(env: Record<string, string> = {}) {
  const reg = mkdtempSync(join(tmpdir(), "hcg-mail-macos-registry-"));
  writeFileSync(join(reg, "offers.json"), JSON.stringify({ offers: [] }));
  writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));
  h = await startHarness({ env: { ...ENV, HCG_STORE_OFFERS_FILE: join(reg, "offers.json"), HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"), ...env } });
  const ledger = h.authority as TestLedgerAuthority;
  for (const f of ["store.publish", "store.release.approve", "store.release.publish"]) ledger.grant(FOUNDER.sub, "hcg.store", featureEdition(f), "hcg-erp", null);
}
afterEach(async () => {
  await h?.stop();
  h = undefined as unknown as Harness;
});

type Client = Awaited<ReturnType<Harness["signIn"]>>;
const post = async (c: Client, path: string, body: unknown = {}) => {
  const res = await c.post(path, body);
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message?: string }; [k: string]: unknown } };
};
async function publish(id: string) {
  const founder = await h.signIn(FOUNDER);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
  grantException(h.db, { releaseId: id, subject: FOUNDER.sub, reason: "HCG Mail 1.0.0-beta.1, founder-operated (test)", authorisedBy: "founder (test)", performedBy: "operator (test)" }, h.clock.now());
  expect((await post(founder, `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "1.0.0-beta.1", current: true })).status).toBe(200);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/publish`, { confirm: "1.0.0-beta.1", current: true })).status).toBe(200);
}

/** The Windows release as published in production (synthetic bytes in place of the 119 MB HCGMail.exe). */
async function publishWindows() {
  const exe = Buffer.alloc(512);
  exe.write("MZ", 0, "latin1"); exe.writeUInt32LE(0x80, 0x3c); exe.write("PE\0\0", 0x80, "latin1");
  const dir = mkdtempSync(join(tmpdir(), "hcg-mail-win-"));
  mkdirSync(join(dir, "files"));
  writeFileSync(join(dir, "files", "HCGMail.exe"), exe);
  const draft = draftFromRequest(WINDOWS);
  draft.artifacts = [{ ...(draft.artifacts[0] as object), sizeBytes: exe.length, sha256: sha(exe) }];
  const r = await h.app.publishing.importRelease({
    draft, filesDir: join(dir, "files"), passports: {}, requestedEligibility: "public", knownLimitations: WINDOWS.knownLimitations, authorisedBy: "founder (test)", performedBy: "operator (test)",
    source: { kind: "github-release", repository: "F1r3srp3nt/HCG-Mail", tag: "v1.0.0.0-beta.1-windows-x64", tagCommit: "90726ae21d42f25cdc5ca81d97ab334d5dd5dfce", evidenceRun: 45940124443 },
  });
  await publish(r.id);
  return { release: r, bytes: exe };
}

/** As the operator CLI does it: the request's reviewed changes, the rejected list, then the import. */
const importMac = (run: ReturnType<typeof macRun>, req = request(run)) => {
  const draft = withReviewedChanges(req, run.draft);
  refuseRejected(draft);
  return h.app.publishing.importRelease({
    draft, filesDir: join(run.dir, "files"), passports: run.passports, requestedEligibility: req.requestedEligibility, knownLimitations: req.knownLimitations,
    authorisedBy: "founder (test)", performedBy: "operator (test)", source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN },
  });
};

type Edition = { editionId: string; state: string; anonymous?: boolean; downloadsAvailable: boolean; artifacts: { id: string; fileName: string; releaseId: string; details: Record<string, unknown> | null }[] };
const access = async (c: { get: (p: string) => Promise<Response> }) => ((await (await c.get("/api/v1/products/hcg-mail/access")).json()) as { editions: Edition[] }).editions;

describe("HCG Mail 1.0.0-beta.1 for macOS (Apple silicon) next to the Windows x64 release", () => {
  beforeEach(async () => start());

  it("imports the run's two files unchanged as a private draft, with the reviewed notes, notarization and descriptions", async () => {
    const run = macRun();
    const r = await importMac(run);
    expect(r).toMatchObject({ status: "draft", editionId: "macos-desktop", version: "1.0.0-beta.1", build: "4", channel: "beta", distribution: "free", requestedEligibility: "public", createdBy: `import:F1r3srp3nt/HCG-Mail#${RUN}` });
    expect(r.releaseNotes[0]).toBe("HCG Mail 1.0.0-beta.1 for Mac with Apple silicon: public beta. Free.");
    expect(JSON.stringify(r.releaseNotes)).not.toMatch(/free during testing|temporary/);
    expect(r.artifacts.map((a) => [a.fileName, a.status, a.sha256, a.kind]).sort()).toEqual([
      [PKG, "verified", sha(run.files[PKG]!), "installer"],
      [ZIP, "verified", sha(run.files[ZIP]!), "portable-app"],
    ]);
    for (const a of r.artifacts) {
      expect(a).toMatchObject({ platform: "macos", architectures: ["arm64"], minimumOs: "macOS 11" });
      expect(a.provenance).toMatchObject({ sourceCommit: COMMIT, buildProvider: "github-actions" });
    }
    const signing = (h.db.prepare("SELECT file_name, signing_reported FROM pub_artifacts WHERE release_id = ?").all(r.id) as { file_name: string; signing_reported: string }[])
      .map((x) => [x.file_name, JSON.parse(x.signing_reported).status]).sort();
    expect(signing).toEqual([[PKG, "notarized"], [ZIP, "notarized"]]);
  });

  it("refuses other bytes, a missing or mismatched passport, an unsigned file claimed notarized, and the rejected files", async () => {
    const run = macRun();
    writeFileSync(join(run.dir, "files", PKG), Buffer.concat([run.files[PKG]!, Buffer.from("x")]));
    await expect(importMac(run)).rejects.toThrow(/SHA-256|bytes/);
    const run2 = macRun();
    await expect(importMac(run2, request(run2, { source: { repository: "F1r3srp3nt/HCG-Mail", commit: COMMIT, runId: RUN } }))).resolves.toBeTruthy();
    const run3 = macRun();
    delete (run3.passports as Record<string, unknown>)[ZIP];
    await expect(importMac(run3)).rejects.toThrow(/no Release Passport/);
    const run4 = macRun();
    (run4.draft.artifacts[0] as { signing: { status: string } }).signing.status = "unsigned";
    expect(() => withReviewedChanges(request(run4), run4.draft)).toThrow(/only a file the run reports as signed/);
    // The previously rejected macOS files: refused by SHA-256 at every route.
    const rejected = JSON.parse(readFileSync(join(IMPORTS, "rejected-artifacts.json"), "utf8")) as { rejected: { sha256: string; fileName: string }[] };
    expect(new Set(rejected.rejected.map((x) => x.sha256))).toEqual(REJECTED_SHA256);
    for (const x of rejected.rejected) {
      expect(() => refuseRejected({ release: {}, artifacts: [{ fileName: x.fileName, sha256: x.sha256 }] })).toThrow(/refused this file earlier/);
    }
  });

  it("after the founder publishes it: macOS is available too, both macOS files download without an account, and Windows is unchanged", async () => {
    const win = await publishWindows();
    const visitor = h.anonymous();
    const before = await access(visitor);
    const winFile = before.find((e) => e.editionId === "windows-desktop")!.artifacts[0]!;
    expect(before.find((e) => e.editionId === "macos-desktop")).toMatchObject({ downloadsAvailable: false, artifacts: [] });

    const run = macRun();
    const mac = await importMac(run);
    // A draft downloads nothing.
    for (const a of mac.artifacts) expect((await visitor.get(`/api/v1/downloads/${a.id}`)).status).toBe(401);
    await publish(mac.id);

    const after = await access(visitor);
    expect(after.find((e) => e.editionId === "windows-desktop")!.artifacts).toEqual([winFile]);
    const m = after.find((e) => e.editionId === "macos-desktop")!;
    expect(m).toMatchObject({ state: "free", anonymous: true, downloadsAvailable: true });
    expect(m.artifacts.map((a) => [a.fileName, a.details?.platform, a.details?.format, a.details?.architectures, a.details?.signing, a.details?.version]).sort()).toEqual([
      [PKG, "macos", "pkg", ["arm64"], "notarized", "1.0.0-beta.1"],
      [ZIP, "macos", "zip", ["arm64"], "notarized", "1.0.0-beta.1"],
    ]);
    for (const a of m.artifacts) {
      const dl = await visitor.get(`/api/v1/downloads/${a.id}`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="${a.fileName}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
      expect(sha(Buffer.from(await dl.arrayBuffer()))).toBe(sha(run.files[a.fileName]!));
    }
    // The Windows file: same ID, same bytes, still current.
    const wdl = await visitor.get(`/api/v1/downloads/${winFile.id}`);
    expect(sha(Buffer.from(await wdl.arrayBuffer()))).toBe(sha(win.bytes));
    const winRow = h.db.prepare("SELECT status, availability FROM pub_releases WHERE id = ?").get(win.release.id);
    expect(winRow).toEqual({ status: "published", availability: "available" });

    // Live publications list both releases; the product head names both platforms; no payment exists.
    const live = (await (await visitor.get("/api/public/v1/published")).json()) as { products: Record<string, { releaseId: string; editionId: string; files: { fileName: string }[] }[]> };
    expect(live.products["hcg-mail"]!.map((p) => [p.editionId, p.files.map((f) => f.fileName).sort()]).sort()).toEqual([["macos-desktop", [PKG, ZIP]], ["windows-desktop", ["HCGMail.exe"]]]);
    expect(JSON.stringify(live)).not.toMatch(/\/api\/v1\/downloads|https?:\/\//);
    const res = (await (await visitor.get("/api/public/v1/release-resolution/hcg-mail?platform=macos")).json()) as { options: { access: { kind: string; requiresHcgAccount: boolean } }[] };
    expect(res.options[0]!.access).toEqual({ kind: "free-public", requiresHcgAccount: false });
    expect((await (await visitor.get("/api/v1/health")).json()) as Record<string, unknown>).toMatchObject({ payments: "disabled" });
  });

  it("the product page head describes both platforms", async () => {
    const site = mkdtempSync(join(tmpdir(), "hcg-mail-macos-site-"));
    writeFileSync(join(site, "index.html"), '<!doctype html><html><head>\n<meta name="description" content="default" />\n<title>HCG Store</title>\n</head><body></body></html>');
    await h.stop();
    await start({ HCG_STORE_STATIC_DIR: site });
    await publishWindows();
    await publish((await importMac(macRun())).id);
    const html = await (await h.anonymous().get("/apps/hcg-mail")).text();
    expect(html).toMatch(/Public Beta 1\.0\.0-beta\.1 for (Windows \(x64\) and macOS \(arm64\)|macOS \(arm64\) and Windows \(x64\))\. Free download, no account required\./);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]!) as Record<string, unknown>;
    expect(ld).toMatchObject({ softwareVersion: "1.0.0-beta.1", offers: { price: "0", priceCurrency: "NOK" } });
    expect(String(ld.operatingSystem).split(", ").sort()).toEqual(["Windows (x64)", "macOS (arm64)"]);
  });
});
