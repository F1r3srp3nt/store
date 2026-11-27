// @vitest-environment node
/**
 * HCG Mail 1.0.0 | Public Beta 1 for Windows x64, with the production settings proposed for it:
 *   - the committed GitHub-release import request (release-imports/hcg-mail-windows-1.0.0-beta.1.json): a hand-built
 *     file, imported unchanged as a manual upload with no build evidence claimed;
 *   - the real catalogue: the HCG Mail Windows edition is permanently free and needs no account;
 *   - HCG_STORE_PUBLICATION_PRODUCTS=hcg-mail (only HCG Mail can be approved, published or delivered);
 *   - HCG_STORE_ANONYMOUS_FREE_PRODUCTS=hcg-mail (its free public files download without an HCG account);
 *   - no payment provider.
 * The file is a small synthetic Windows PE standing in for HCGMail.exe (same declaration, other bytes).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStoreConfig } from "../src/config";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { grantFounderException as grantException } from "../src/release-exceptions";
import { draftFromRequest, ImportRequestSchema } from "../src/release-import-request";
import { startHarness, type Harness } from "./harness";

const FOUNDER = { sub: "user-founder-test", email: "founder@example.test", name: "Founder" };
const TESTER = { sub: "user-tester-test", email: "tester@example.test", name: "Tester" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const REQUEST = ImportRequestSchema.parse(JSON.parse(readFileSync(join(__dirname, "..", "..", "release-imports", "hcg-mail-windows-1.0.0-beta.1.json"), "utf8")));

function pe(tag: string): Buffer {
  const b = Buffer.alloc(512);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.write(tag, 0x100, "latin1");
  return b;
}

/** The committed request's draft, with the synthetic bytes in place of the real 119 MB file. */
function folder(override: Record<string, unknown> = {}) {
  const bytes = pe("HCG Mail 1.0.0");
  const dir = mkdtempSync(join(tmpdir(), "hcg-mail-beta-"));
  mkdirSync(join(dir, "files"));
  writeFileSync(join(dir, "files", "HCGMail.exe"), bytes);
  const draft = draftFromRequest(REQUEST);
  draft.artifacts = [{ ...(draft.artifacts[0] as object), sizeBytes: bytes.length, sha256: sha(bytes), ...override }];
  return { dir, draft, bytes };
}

const SOURCE = { kind: "github-release" as const, repository: "F1r3srp3nt/HCG-Mail", tag: "v1.0.0.0-beta.1-windows-x64", tagCommit: "90726ae21d42f25cdc5ca81d97ab334d5dd5dfce", evidenceRun: 45940124443 };

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
let ledger: TestLedgerAuthority;
const grantFounderException = (hh: Harness, releaseId: string, subject: string) =>
  grantException(hh.db, { releaseId, subject, reason: "HCG Mail 1.0.0 Public Beta 1, founder-operated (test)", authorisedBy: "founder (test)", performedBy: "operator (test)" }, hh.clock.now());
async function start(env: Record<string, string> = {}) {
  const reg = mkdtempSync(join(tmpdir(), "hcg-mail-beta-registry-"));
  writeFileSync(join(reg, "offers.json"), JSON.stringify({ offers: [] }));
  writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));
  h = await startHarness({ env: { ...ENV, HCG_STORE_OFFERS_FILE: join(reg, "offers.json"), HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"), ...env } });
  ledger = h.authority as TestLedgerAuthority;
  for (const f of ["store.publish", "store.release.approve", "store.release.publish"]) ledger.grant(FOUNDER.sub, "hcg.store", featureEdition(f), "hcg-erp", null);
}
afterEach(async () => {
  await h?.stop();
  h = undefined as unknown as Harness;
});

const doImport = (f: ReturnType<typeof folder>) =>
  h.app.publishing.importRelease({
    draft: f.draft, filesDir: join(f.dir, "files"), passports: {}, source: SOURCE, requestedEligibility: "public",
    knownLimitations: REQUEST.knownLimitations, authorisedBy: "founder (test)", performedBy: "operator (test)",
  });

type Client = Awaited<ReturnType<Harness["signIn"]>>;
const post = async (c: Client, path: string, body: unknown = {}) => {
  const res = await c.post(path, body);
  return { status: res.status, body: (await res.json()) as { error?: { code: string }; [k: string]: unknown } };
};
async function publish(id: string) {
  const founder = await h.signIn(FOUNDER);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
  grantFounderException(h, id, FOUNDER.sub);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "1.0.0-beta.1", current: true })).status).toBe(200);
  expect((await post(founder, `/api/v1/publishing/releases/${id}/publish`, { confirm: "1.0.0-beta.1", current: true })).status).toBe(200);
  return founder;
}
type Edition = { editionId: string; state: string; owned: boolean; anonymous?: boolean; offers: unknown[]; checkoutReady: boolean; downloadsAvailable: boolean; artifacts: { id: string; fileName: string; details: Record<string, unknown> | null }[] };
const windowsAccess = async (c: Client) => ((await (await c.get("/api/v1/products/hcg-mail/access")).json()) as { editions: Edition[] }).editions.find((e) => e.editionId === "windows-desktop")!;

describe("HCG Mail 1.0.0 | Public Beta 1 (Windows x64): GitHub release import, free download without an account", () => {
  beforeEach(async () => start());

  it("the committed request declares one unsigned x64 EXE as a manual upload, pinned to GitHub's digest", () => {
    expect(REQUEST.source).toMatchObject({ kind: "github-release", tag: "v1.0.0.0-beta.1-windows-x64" });
    expect(REQUEST.expect).toMatchObject({ productId: "hcg-mail", editionId: "windows-desktop", version: "1.0.0-beta.1", channel: "beta", distribution: "free", files: 1 });
    expect(REQUEST.expect.sha256).toEqual({ "HCGMail.exe": "0424c7c6a264b66da841e320b2661fdcf9b2d8bf0bf17e3ab1ec92af32202fdf" });
    const [a] = REQUEST.release!.artifacts as Record<string, unknown>[];
    expect(a).toMatchObject({ fileName: "HCGMail.exe", platform: "windows", format: "exe", sizeBytes: 119023581, architectures: ["x64"], buildProvider: "manual-upload", sourceCommit: null, toolchain: null, signing: { status: "unsigned" } });
    expect(a!.sha256).toBe(REQUEST.expect.sha256["HCGMail.exe"]);
  });

  it("imports the file unchanged as a private draft from the GitHub release, claiming no build evidence", async () => {
    const f = folder();
    const r = await doImport(f);
    expect(r).toMatchObject({ status: "draft", requestedEligibility: "public", distribution: "free", version: "1.0.0-beta.1", build: "1.0.0.0", channel: "beta", createdBy: "import:F1r3srp3nt/HCG-Mail@v1.0.0.0-beta.1-windows-x64" });
    expect(r.importedFrom).toMatchObject({ kind: "github-release", tag: SOURCE.tag, tagCommit: SOURCE.tagCommit, evidenceRun: SOURCE.evidenceRun });
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]).toMatchObject({ fileName: "HCGMail.exe", status: "verified", sha256: sha(f.bytes), architectures: ["x64"] });
    expect(r.artifacts[0]!.provenance).toMatchObject({ buildProvider: "manual-upload", sourceCommit: null });
    expect(r.knownLimitations[0]).toMatch(/Not code-signed/);
  });

  it("refuses other bytes, a claimed CI build, and a passport", async () => {
    const f = folder();
    writeFileSync(join(f.dir, "files", "HCGMail.exe"), Buffer.concat([f.bytes, Buffer.from("x")]));
    await expect(doImport(f)).rejects.toThrow(/bytes|SHA-256/);
    await expect(doImport(folder({ buildProvider: "github-actions", sourceCommit: SOURCE.tagCommit, toolchain: "dotnet" }))).rejects.toThrow(/manual upload/);
    const g = folder();
    await expect(h.app.publishing.importRelease({ draft: g.draft, filesDir: join(g.dir, "files"), passports: { "HCGMail.exe": { artifact: { filename: "HCGMail.exe", size: 1, sha256: "0", sha512: "0" }, source: { commit: "x" }, build: { run_id: 1 } } }, source: SOURCE, requestedEligibility: "public", knownLimitations: [], authorisedBy: "a", performedBy: "b" })).rejects.toThrow(/no Release Passport/);
    expect((h.db.prepare("SELECT count(*) AS n FROM pub_releases").get() as { n: number }).n).toBe(0);
  });

  it("before publication nothing downloads; after it anyone can download, free, with its version, architecture and size", async () => {
    const f = folder();
    const r = await doImport(f);
    const visitor = h.anonymous();
    const fileId = r.artifacts[0]!.id;
    expect((await visitor.get(`/api/v1/downloads/${fileId}`)).status).toBe(401);
    expect(await windowsAccess(visitor)).toMatchObject({ state: "signed-out", downloadsAvailable: false, artifacts: [] });

    await publish(r.id);
    const open = await windowsAccess(visitor);
    expect(open).toMatchObject({ state: "free", owned: false, anonymous: true, downloadsAvailable: true, offers: [], checkoutReady: false });
    expect(open.artifacts).toEqual([{
      id: fileId, fileName: "HCGMail.exe", releaseId: r.id,
      details: expect.objectContaining({ version: "1.0.0-beta.1", channel: "beta", platform: "windows", format: "exe", architectures: ["x64"], sizeBytes: f.bytes.length, sha256: sha(f.bytes), signing: "unsigned" }),
    }]);
    const dl = await visitor.get(`/api/v1/downloads/${fileId}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain('filename="HCGMail.exe"');
    expect(dl.headers.get("cache-control")).toContain("no-store");
    expect(sha(Buffer.from(await dl.arrayBuffer()))).toBe(sha(f.bytes));
    // A signed-in customer gets the same free file; nothing is bought or charged.
    const tester = await h.signIn(TESTER);
    expect(await windowsAccess(tester)).toMatchObject({ state: "free", owned: false, offers: [], checkoutReady: false });
    expect((await tester.get(`/api/v1/downloads/${fileId}`)).status).toBe(200);
    for (const table of ["purchases", "payment_events"]) {
      const exists = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (exists) expect((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect((await (await visitor.get("/api/v1/health")).json()) as Record<string, unknown>).toMatchObject({ payments: "disabled", anonymousFreeProducts: ["hcg-mail"] });
    // Public release resolution: free, no account, no URL.
    const res = (await (await visitor.get("/api/public/v1/release-resolution/hcg-mail?platform=windows")).json()) as { options: { access: { kind: string; requiresHcgAccount: boolean } }[] };
    expect(res.options[0]!.access).toEqual({ kind: "free-public", requiresHcgAccount: false });
    expect(JSON.stringify(res)).not.toMatch(/\/api\/v1\/downloads/);
  });

  it("withdrawn, revoked or disabled releases stop downloading at once, for everyone", async () => {
    const r = await doImport(folder());
    const founder = await publish(r.id);
    const visitor = h.anonymous();
    const fileId = r.artifacts[0]!.id;
    expect((await visitor.get(`/api/v1/downloads/${fileId}`)).status).toBe(200);
    const act = (path: string, body: unknown) => founder.post(path, body);
    expect((await act(`/api/v1/publishing/releases/${r.id}/disable`, { reason: "test: stop delivery" })).status).toBe(200);
    expect((await visitor.get(`/api/v1/downloads/${fileId}`)).status).toBe(401);
    expect((await windowsAccess(visitor)).artifacts).toEqual([]);
    expect((await act(`/api/v1/publishing/releases/${r.id}/revoke`, { reason: "test: revoked", confirm: "1.0.0-beta.1" })).status).toBe(200);
    expect((await visitor.get(`/api/v1/downloads/${fileId}`)).status).toBe(401);
    const tester = await h.signIn(TESTER);
    expect([403, 404, 410]).toContain((await tester.get(`/api/v1/downloads/${fileId}`)).status);
  });

  it("visitors without an account are rate-limited; they can never upload or change releases", async () => {
    const r = await doImport(folder());
    await publish(r.id);
    const visitor = h.anonymous();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await visitor.get(`/api/v1/downloads/${r.artifacts[0]!.id}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await visitor.post("/api/v1/publishing/releases", { productId: "hcg-mail" })).status).toBe(401);
    expect((await visitor.post(`/api/v1/publishing/releases/${r.id}/withdraw`, { reason: "x" })).status).toBe(401);
    const tester = await h.signIn(TESTER);
    expect((await post(tester, `/api/v1/publishing/releases/${r.id}/withdraw`, { reason: "x" })).status).toBe(403);
    expect((await post(tester, "/api/v1/publishing/releases", { productId: "hcg-mail", version: "9.9.9", build: "1", distribution: "free", eligibility: "private" })).status).toBe(403);
  });
});

describe("the limits are product-specific", () => {
  it("without HCG Mail in the anonymous list, its free file needs an HCG account", async () => {
    await start({ HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "hcg-nexus" });
    const r = await doImport(folder());
    await publish(r.id);
    expect((await h.anonymous().get(`/api/v1/downloads/${r.artifacts[0]!.id}`)).status).toBe(401);
    expect((await (await h.signIn(TESTER)).get(`/api/v1/downloads/${r.artifacts[0]!.id}`)).status).toBe(200);
  });

  it("outside HCG_STORE_PUBLICATION_PRODUCTS nothing can be approved or published, even by the founder", async () => {
    await start({ HCG_STORE_PUBLICATION_PRODUCTS: "hcg-nexus", HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "" });
    const r = await doImport(folder());
    const founder = await h.signIn(FOUNDER);
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/submit`)).status).toBe(200);
    grantFounderException(h, r.id, FOUNDER.sub);
    expect((await post(founder, `/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: "1.0.0-beta.1" })).body.error?.code).toBe("publication_disabled");
  });

  it("production needs the founder's explicit approval for downloads without an account, and free downloads switched on", () => {
    const base = { HCG_STORE_MODE: "production", HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test", HCG_STORE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") };
    const problems = (env: Record<string, string>) => { try { parseStoreConfig({ ...base, ...env }); return ""; } catch (e) { return (e as Error).message; } };
    expect(problems({ HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "hcg-mail" })).toMatch(/HCG_STORE_ANONYMOUS_FREE_PRODUCTS needs HCG_STORE_PROTECTED_DOWNLOADS/);
    expect(problems({ HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "hcg-mail" })).toMatch(/HCG_STORE_ANONYMOUS_FREE_APPROVED=founder-approved/);
    expect(problems({ HCG_STORE_ANONYMOUS_FREE_PRODUCTS: "HCG Mail" })).toMatch(/catalogue product IDs/);
    expect(problems({ HCG_STORE_PUBLICATION_PRODUCTS: "hcg mail" })).toMatch(/HCG_STORE_PUBLICATION_PRODUCTS must list/);
  });
});
