// @vitest-environment node
/**
 * Distribution Studio (HCG Executable Maker) additions to the publishing API: product metadata in the product list,
 * descriptive draft products, the submitter's publication request (make current, supersede compatible), recorded
 * availability requests that change nothing, and the "compatible" supersede scope applied only at publication.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Harness } from "./harness";

const MAKER = "99999999-8888-4777-8666-555555555555";
const PUBLISHER = { sub: "user-publisher", email: "pub@example.test", name: "Publisher" };
const APPROVER = { sub: "user-approver", email: "approver@example.test", name: "Approver" };
const STRANGER = { sub: "user-stranger", email: "x@example.test", name: "Stranger" };
const PRODUCT = "fixture-quasar-shell";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PROV = { sourceCommit: "0123abcd", buildProvider: "local", toolchain: ".NET SDK 10.0 (test)" };

function pe(tag: string, machine = 0x8664): Buffer {
  const b = Buffer.alloc(4096);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(machine, 0x84); b.write(tag, 0x200, "latin1");
  return b;
}

let h: Harness | undefined;
async function start(mode: "uploads" | "enabled") {
  h = await startHarness({
    env: {
      HCG_STORE_PUBLISHING: mode, HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER, HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      ...(mode === "enabled" ? { HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish" } : {}),
    },
  });
  h.idp.otherClients.add(MAKER);
  const ledger = h.authority as TestLedgerAuthority;
  ledger.grant(PUBLISHER.sub, "*", featureEdition("store.publish"), "test", null);
  ledger.grant(APPROVER.sub, "*", featureEdition("store.release.approve"), "test", null);
  ledger.grant(APPROVER.sub, "*", featureEdition("store.release.publish"), "test", null);
  return h;
}
afterEach(async () => { await h?.stop(); h = undefined; });

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(h!.origin + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const token = (user = PUBLISHER) => h!.idp.accessToken(user, MAKER);

/** A release of PRODUCT with one verified Windows file per (machine, arch) pair, submitted, approved for public use. */
async function approvedRelease(t: string, version: string, build: string, files: { arch: "x64" | "arm64" }[], extra: Record<string, unknown> = {}) {
  const rel = await call(t, "POST", "/api/v1/publishing/releases", { productId: PRODUCT, editionId: "standard", version, build, distribution: "paid", eligibility: "public", releaseNotes: ["Test release."], ...extra });
  expect(rel.status, JSON.stringify(rel.body)).toBe(201);
  for (const f of files) {
    const bytes = pe(`${version}-${build}-${f.arch}`, f.arch === "x64" ? 0x8664 : 0xaa64);
    const d = await call(t, "POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: `Q-${version}-${f.arch}.exe`, platform: "windows", format: "exe", sizeBytes: bytes.length, sha256: sha(bytes), architectures: [f.arch], ...PROV });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` }, body: bytes });
    expect((await call(t, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`)).body.artifact.status).toBe("verified");
  }
  const sub = await call(t, "POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
  if (sub.status !== 200) console.log("SUBMIT", JSON.stringify(sub.body));
  expect(sub.status).toBe(200);
  const approver = await h!.signIn(APPROVER);
  const ap = await approver.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: version });
  if (ap.status !== 200) console.log("APPROVE", await ap.clone().text());
  expect(ap.status).toBe(200);
  return { id: rel.body.id as string, approver };
}

describe("Distribution Studio: products", () => {
  it("lists authorised products with official metadata, and draft products with their descriptive fields", async () => {
    await start("uploads");
    const t = await token();
    const caps = (await call(t, "GET", "/api/v1/publishing/capabilities")).body;
    expect(caps).toMatchObject({ publishingMode: "uploads", capabilities: { uploads: true, approval: false, publication: false, productMetadata: true, publicationRequests: true, availabilityRequests: true, supersedeCompatible: true } });
    const products = (await call(t, "GET", "/api/v1/publishing/products")).body.products as Record<string, any>[];
    const q = products.find((p) => p.id === PRODUCT)!;
    expect(q).toMatchObject({ source: "catalogue", slug: expect.any(String), category: expect.any(String), developmentStatus: expect.any(String), productUrl: expect.stringContaining("/apps/") });
    expect(Array.isArray(q.platforms)).toBe(true);
    expect(q.editions.map((e: { id: string }) => e.id)).toContain("standard");

    const draft = await call(t, "POST", "/api/v1/publishing/products", { id: "orbit-tools", title: "Orbit Tools", description: "Command-line tools.", category: "developer-tools", platforms: ["windows", "macos"] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.note).toMatch(/reviewed catalogue/);
    const listed = ((await call(t, "GET", "/api/v1/publishing/products")).body.products as Record<string, any>[]).find((p) => p.id === "orbit-tools");
    expect(listed).toMatchObject({ source: "draft", summary: "Command-line tools.", category: "developer-tools", developmentStatus: "draft", icon: null });
    expect(listed!.platforms.map((p: { platform: string }) => p.platform)).toEqual(["windows", "macos"]);
    // Nothing lists or grants it: a stranger sees nothing, and the public resolution does not know it.
    expect((await call(await token(STRANGER), "GET", "/api/v1/publishing/products")).body.products).toEqual([]);
    expect((await h!.anonymous().get("/api/public/v1/release-resolution/orbit-tools")).status).toBe(404);
  });
});

describe("Distribution Studio: publication requests and supersede", () => {
  it("records the request with the draft and applies it only at publication: compatible scope keeps other platforms and channels", async () => {
    await start("enabled");
    const t = await token();
    // Published before: v1 x64 (beta) and a stable-channel release, and an ARM64-only beta release.
    const v1 = await approvedRelease(t, "1.0.0", "1", [{ arch: "x64" }]);
    const stable = await approvedRelease(t, "1.0.0", "2", [{ arch: "x64" }], { channel: "stable" });
    const arm = await approvedRelease(t, "1.0.0", "3", [{ arch: "arm64" }]);
    for (const x of [v1, stable, arm]) { const pr = await x.approver.post(`/api/v1/publishing/releases/${x.id}/publish`, { confirm: "1.0.0" }); expect(pr.status, await pr.clone().text()).toBe(200); }

    // v2 (beta, x64 only) asks to become current and supersede the previous compatible release.
    const v2 = await approvedRelease(t, "2.0.0", "4", [{ arch: "x64" }], { publicationRequest: { makeCurrent: true, supersedePrevious: "compatible" } });
    const view = (await call(t, "GET", `/api/v1/publishing/releases/${v2.id}`)).body;
    expect(view.publicationRequest).toEqual({ makeCurrent: true, supersedePrevious: "compatible" });
    // Approval alone changes nothing about the published releases.
    expect((await call(t, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.status).toBe("published");
    // The publisher's review page pre-selects the compatible scope.
    expect(await (await v2.approver.get(`/publishing/releases/${v2.id}`)).text()).toContain("supersede the previous compatible releases");

    const pub = await v2.approver.post(`/api/v1/publishing/releases/${v2.id}/publish`, { confirm: "2.0.0", supersede: true });
    expect(pub.status).toBe(200);
    const status = async (id: string) => (await call(t, "GET", `/api/v1/publishing/releases/${id}`)).body.status;
    expect(await status(v1.id)).toBe("superseded");       // same channel, every platform/arch it offered is offered by v2
    expect(await status(stable.id)).toBe("published");     // another channel: kept
    expect(await status(arm.id)).toBe("published");        // ARM64 not offered by v2: kept
    expect((await call(t, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.artifacts[0].status).toBe("verified");   // history and files kept
  });

  it("a failed publication supersedes nothing and leaves the current release current", async () => {
    await start("enabled");
    const t = await token();
    const v1 = await approvedRelease(t, "1.0.0", "1", [{ arch: "x64" }]);
    expect((await v1.approver.post(`/api/v1/publishing/releases/${v1.id}/publish`, { confirm: "1.0.0" })).status).toBe(200);
    const rel = await call(t, "POST", "/api/v1/publishing/releases", { productId: PRODUCT, editionId: "standard", version: "2.0.0", build: "9", distribution: "paid", eligibility: "public", publicationRequest: { makeCurrent: true, supersedePrevious: "compatible" } });
    // Not approved: publication fails (also a wrong confirmation, and from a desktop app).
    expect((await v1.approver.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "2.0.0", supersede: true })).status).toBe(409);
    expect((await call(t, "POST", `/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "2.0.0", supersede: true })).status).toBe(403);
    expect((await call(t, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.status).toBe("published");
  });

  it("availability requests are recorded for approvers, need the typed version and change nothing", async () => {
    await start("enabled");
    const t = await token();
    const v1 = await approvedRelease(t, "1.0.0", "1", [{ arch: "x64" }]);
    expect((await v1.approver.post(`/api/v1/publishing/releases/${v1.id}/publish`, { confirm: "1.0.0" })).status).toBe(200);
    expect((await call(t, "POST", `/api/v1/publishing/releases/${v1.id}/requests`, { action: "disable", reason: "Crash on start.", confirm: "9.9.9" })).status).toBe(400);
    const r = await call(t, "POST", `/api/v1/publishing/releases/${v1.id}/requests`, { action: "disable", reason: "Crash on start.", confirm: "1.0.0" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ recorded: true, requests: [{ action: "disable", reason: "Crash on start.", by: PUBLISHER.sub }] });
    expect((await call(t, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.status).toBe("published");
    expect((await call(t, "POST", `/api/v1/publishing/releases/${v1.id}/requests`, { action: "restore", reason: "x", confirm: "1.0.0" })).status).toBe(409);
    expect((await call(await token(STRANGER), "POST", `/api/v1/publishing/releases/${v1.id}/requests`, { action: "disable", reason: "x", confirm: "1.0.0" })).status).toBe(403);
    expect(await (await v1.approver.get(`/publishing/releases/${v1.id}`)).text()).toContain("Crash on start.");
  });

  it("in uploads mode private drafts carry the request, and approval and publication stay off", async () => {
    await start("uploads");
    const t = await token();
    const rel = await call(t, "POST", "/api/v1/publishing/releases", { productId: PRODUCT, editionId: "standard", version: "3.0.0", build: "1", distribution: "paid", eligibility: "public", publicationRequest: { makeCurrent: true, supersedePrevious: "compatible" } });
    expect(rel.status).toBe(201);
    expect(rel.body.publicationRequest).toMatchObject({ makeCurrent: true });
    const approver = await h!.signIn(APPROVER);
    expect((await approver.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "3.0.0" })).status).toBe(409);
  });
});
