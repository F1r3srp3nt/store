// @vitest-environment node
/**
 * HCG_STORE_PUBLISHING=uploads: authorised staff (HCG Executable Maker, HCG Store Manager, the browser) can list their
 * catalogue products, create PRIVATE drafts, upload and resume, attach passports and submit for review, while
 * approval, publication and every customer delivery stay off. Only HCG's store.publish is needed for this mode.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStoreConfig } from "../src/config";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Harness } from "./harness";

const MAKER = "fb9b6edf-2bfc-4b5e-a354-dbb1af697029"; // HCG Executable Maker's issued production client
const FOUNDER = { sub: "user-founder", email: "founder@example.test", name: "Founder" };
const CUSTOMER = { sub: "user-customer", email: "c@example.test", name: "Customer" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let h: Harness;
beforeEach(async () => {
  h = await startHarness({ env: { HCG_STORE_PUBLISHING: "uploads", HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER, HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish", HCG_STORE_UPLOAD_CHUNK_MB: "1" } });
  h.idp.otherClients.add(MAKER);
  (h.authority as TestLedgerAuthority).grant(FOUNDER.sub, "hcg.store", featureEdition("store.publish"), "hcg-erp", null);
});
afterEach(async () => h.stop());

async function maker(user = FOUNDER, client = MAKER) {
  const token = await h.idp.accessToken(user, client);
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
}
const exe = () => { const b = Buffer.alloc(3 * 1024 * 1024); b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(0x8664, 0x84); return b; };

describe("private uploads while publication is off", () => {
  it("only HCG_STORE_PUBLISHER_CENTRAL_ID is required for uploads; enabled still requires all three keys", () => {
    const base = { HCG_STORE_MODE: "test", HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger", HCG_STORE_ARTIFACT_STORAGE_DIR: "/tmp/x", HCG_CONNECT_ISSUER: "https://idp.example", HCG_CONNECT_AUTHORIZATION_ENDPOINT: "https://idp.example/a", HCG_CONNECT_TOKEN_ENDPOINT: "https://idp.example/t", HCG_CONNECT_JWKS_URI: "https://idp.example/j", HCG_CONNECT_CLIENT_ID: "11111111-2222-4333-8444-555555555555", HCG_CONNECT_REDIRECT_URI: "http://127.0.0.1/cb", HCG_STORE_PUBLIC_ORIGIN: "http://127.0.0.1", HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish" };
    expect(parseStoreConfig({ ...base, HCG_STORE_PUBLISHING: "uploads" }).publishing).toMatchObject({ enabled: true, mode: "uploads", publicationEnabled: false });
    expect(() => parseStoreConfig({ ...base, HCG_STORE_PUBLISHING: "enabled" })).toThrow(/APPROVER_CENTRAL_ID/);
    expect(() => parseStoreConfig({ ...base, HCG_STORE_PUBLISHING: "maybe" })).toThrow(/"enabled", "uploads" or "disabled"/);
  });

  it("Executable Maker's journey: health, whoami, capabilities, catalogue products, draft, upload, resume, checksum, submit", async () => {
    expect(await (await fetch(h.origin + "/api/v1/health")).json()).toMatchObject({ publishing: "uploads" });
    const call = await maker();
    expect((await call("GET", "/api/v1/publishing/whoami")).body).toMatchObject({ sub: FOUNDER.sub, via: "desktop", publishingMode: "uploads", capabilities: { uploads: true, approval: false, publication: false, publicDelivery: false } });
    // Existing catalogue products and their editions: no draft product needs to be created.
    const products = (await call("GET", "/api/v1/publishing/products")).body.products as { id: string; source: string; editions: { id: string }[] }[];
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.source === "catalogue")).toBe(true);
    const product = products.find((p) => p.editions.length > 0)!;
    const rel = await call("POST", "/api/v1/publishing/releases", { productId: product.id, editionId: product.editions[0]!.id, version: "1.0.0", build: "1", releaseNotes: ["Private upload."], distribution: "paid", eligibility: "private" });
    expect(rel.status).toBe(201);
    const file = exe();
    const d = await call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "App-Setup.exe", platform: "windows", format: "exe", sizeBytes: file.length, sha256: sha(file), sourceCommit: "0123abcd", buildProvider: "local", toolchain: "HCG Executable Maker 0.4.0" });
    expect(d.status).toBe(201);
    // First chunk, then "lose" the connection and resume from the server's offset.
    await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${1024 * 1024 - 1}/${file.length}` }, body: file.subarray(0, 1024 * 1024) });
    const status = (await (await fetch(d.body.uploadUrl)).json()) as { received: number };
    expect(status.received).toBe(1024 * 1024);
    for (let s = status.received; s < file.length; s += 1024 * 1024) {
      const e = Math.min(file.length, s + 1024 * 1024) - 1;
      expect((await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${s}-${e}/${file.length}` }, body: file.subarray(s, e + 1) })).status).toBe(200);
    }
    const done = await call("POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`);
    expect(done.body.artifact).toMatchObject({ status: "verified", sha256: sha(file) });
    expect((await call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`)).body.status).toBe("submitted");
    // Release Manager in the browser shows it.
    const web = await h.signIn(FOUNDER);
    const manager = (await (await web.get("/api/v1/publishing/manager")).json()) as { releases: { id: string }[] };
    expect(manager.releases.map((r) => r.id)).toContain(rel.body.id);
    expect((await web.get(`/publishing/releases/${rel.body.id}`)).status).toBe(200);
    // Approval and publication are off; nothing reaches customers.
    const approve = await web.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "private", confirm: "1.0.0" });
    expect([approve.status, ((await approve.json()) as { error: { code: string } }).error.code]).toEqual([409, "publication_disabled"]);
    const customer = await h.signIn(CUSTOMER);
    expect((await customer.get(`/api/v1/downloads/${d.body.artifact.id}`)).status).toBeGreaterThanOrEqual(403);
    const viaLink = await customer.post(`/api/v1/publishing/artifacts/${d.body.artifact.id}/download-url`, {});
    expect(viaLink.status).toBe(403);
  });

  it("ordinary accounts and other applications get nothing", async () => {
    expect((await (await maker(CUSTOMER))("GET", "/api/v1/publishing/products")).body.products).toEqual([]);
    expect((await (await maker(CUSTOMER))("POST", "/api/v1/publishing/releases", { productId: "fixture-quasar-shell", editionId: "standard", version: "1.0.0", build: "1", distribution: "paid", eligibility: "private" })).status).toBe(403);
    expect((await (await maker(FOUNDER, "00000000-0000-4000-8000-000000000000"))("GET", "/api/v1/publishing/whoami")).status).toBe(401);
    expect((await (await maker(FOUNDER, h.idp.clientId))("GET", "/api/v1/publishing/whoami")).status).toBe(401); // the Store's own client
  });
});
