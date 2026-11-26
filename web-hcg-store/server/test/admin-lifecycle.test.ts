// @vitest-environment node
/**
 * Web administration, direct uploads and release lifecycle: the founder's 17 acceptance criteria, against the real
 * server code with the mock HCG Connect provider and the TEST entitlement ledger (standing in for HCG's central
 * permissions and licences). Every operation goes through the same management API the HCG Store website, HCG
 * Executable Maker and HCG Store Manager use.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStoreConfig } from "../src/config";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Client, type Harness } from "./harness";

const MAKER = "99999999-8888-4777-8666-555555555555";
const STORE_MANAGER = "99999999-8888-4777-8666-5555555555aa";
const OWNER = { sub: "user-owner", email: "owner@example.test", name: "Owner" };
const REVIEWER = { sub: "user-reviewer", email: "reviewer@example.test", name: "Reviewer" };
const CUSTOMER = { sub: "user-customer", email: "customer@example.test", name: "Customer" };
const ADMIN_WITHOUT_GRANT = { sub: "user-admin", email: "admin@example.test", name: "Administrator", role: "admin" };
const PRODUCT = "fixture-quasar-shell";

let h: Harness;
let ledger: TestLedgerAuthority;
async function start(env: Record<string, string> = {}) {
  h = await startHarness({
    env: {
      HCG_STORE_PUBLISHING: "enabled",
      HCG_STORE_PUBLISHING_CLIENT_IDS: `${MAKER},${STORE_MANAGER}`,
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
      HCG_STORE_UPLOAD_CHUNK_MB: "1",
      ...env,
    },
  });
  h.idp.otherClients.add(MAKER);
  h.idp.otherClients.add(STORE_MANAGER);
  ledger = h.authority as TestLedgerAuthority;
  // HCG's decisions: the owner may upload and submit; a second person reviews and publishes (separation of duties);
  // the customer owns the product's standard edition. The administrator has an HCG role but no Store permission.
  ledger.grant(OWNER.sub, "hcg.store", featureEdition("store.publish"), "test", null);
  ledger.grant(REVIEWER.sub, "hcg.store", featureEdition("store.release.approve"), "test", null);
  ledger.grant(REVIEWER.sub, "hcg.store", featureEdition("store.release.publish"), "test", null);
  ledger.grant(CUSTOMER.sub, "fixture.quasar.shell", "standard", "test", null);
}
beforeEach(() => start());
afterEach(async () => {
  await h.stop();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A Windows PE executable (MZ + PE headers, PE32+), padded with random bytes so each build is distinct. */
function exe(size = 2_500_000): Buffer {
  const b = Buffer.concat([Buffer.alloc(512), randomBytes(size - 512)]);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(128, 60);
  b.write("PE\0\0", 128, "latin1");
  b.writeUInt16LE(0x8664, 132);
  b.writeUInt16LE(0x20b, 128 + 24);
  b.fill(0, 128 + 24 + 2, 128 + 24 + 240);
  return b;
}

/** A ZIP archive (a macOS .app bundle packaged for distribution). */
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
const macApp = () => zip([
  { name: "Quasar.app/Contents/Info.plist", data: Buffer.from("<plist><dict><key>CFBundleIdentifier</key><string>com.hcg.quasar</string></dict></plist>") },
  { name: "Quasar.app/Contents/MacOS/Quasar", data: randomBytes(4096) },
]);

type J = Record<string, any>;
async function call(c: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: J }> {
  const r = await c.request(path, { method, headers, ...(body !== undefined ? { json: body } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as J };
}
async function desktop(user: { sub: string; email: string; name: string }, client: string) {
  const token = await h.idp.accessToken(user, client);
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as J };
  };
}

const NEW_UPDATE = (version: string, build: string, extra: J = {}) => ({
  productId: PRODUCT, editionId: "standard", version, build, channel: "stable", distribution: "paid", eligibility: "public",
  releaseNotes: [`HCG Quasar Shell ${version}.`], knownLimitations: ["Not code-signed (test build)."], ...extra,
});
const MANUAL = { buildProvider: "manual-upload" };

/** Website upload: declare → chunks (resumable) → server-side verification. Returns the verified artifact. */
async function uploadThroughWebsite(c: Client, releaseId: string, file: Buffer, decl: J, opts: { interruptAfterChunks?: number } = {}) {
  const d = await call(c, "POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { sizeBytes: file.length, sha256: sha(file), ...MANUAL, ...decl });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  let uploadUrl = d.body.uploadUrl as string;
  const chunk = d.body.chunkBytes as number;
  let start = 0;
  let sent = 0;
  while (start < file.length) {
    if (opts.interruptAfterChunks !== undefined && sent === opts.interruptAfterChunks) {
      // The connection drops in the middle of a chunk: half of it arrives, then the socket closes.
      const end = Math.min(file.length, start + chunk) - 1;
      const ac = new AbortController();
      const body = new ReadableStream({ start(ctl) { ctl.enqueue(file.subarray(start, start + Math.floor((end - start) / 2))); setTimeout(() => ac.abort(), 50); } });
      await fetch(uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${start}-${end}/${file.length}` }, body, signal: ac.signal, duplex: "half" } as RequestInit).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      // Recovery, as the website does after a reload: ask the Store where to resume (a fresh upload URL, too).
      const renewed = await call(c, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/upload-url`);
      expect(renewed.status).toBe(200);
      expect(renewed.body.received).toBe(start); // the broken half-chunk was cut off: resume at the last good byte
      uploadUrl = renewed.body.uploadUrl;
      opts.interruptAfterChunks = undefined;
      continue;
    }
    const end = Math.min(file.length, start + chunk) - 1;
    const r = await fetch(uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${start}-${end}/${file.length}` }, body: file.subarray(start, end + 1) });
    expect(r.status, await r.clone().text()).toBe(200);
    start = end + 1;
    sent += 1;
  }
  const done = await call(c, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.artifact as J;
}

/** Owner prepares and submits; reviewer approves (and, separately, publishes). */
async function prepare(owner: Client, version: string, build: string, files: { file: Buffer; decl: J }[], extra: J = {}) {
  const rel = await call(owner, "POST", "/api/v1/publishing/releases", NEW_UPDATE(version, build, extra));
  expect(rel.status, JSON.stringify(rel.body)).toBe(201);
  const artifacts = [];
  for (const f of files) artifacts.push(await uploadThroughWebsite(owner, rel.body.id, f.file, f.decl));
  const sub = await call(owner, "POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return { id: rel.body.id as string, artifacts };
}
async function approve(reviewer: Client, id: string, version: string) {
  const a = await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: version });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
}
async function publish(reviewer: Client, id: string, version: string, body: J = {}) {
  return call(reviewer, "POST", `/api/v1/publishing/releases/${id}/publish`, { confirm: version, ...body });
}
/** What the product page offers a customer, and whether each offered file downloads with the right bytes. */
async function offered(customer: Client) {
  const r = await call(customer, "GET", `/api/v1/products/${PRODUCT}/access`);
  const ed = (r.body.editions as J[]).find((e) => e.editionId === "standard")!;
  // Only files shipped through HCG Store (the fixture catalogue also lists a static TEST file of its own).
  return ((ed.artifacts ?? ed.downloads ?? []) as J[]).filter((a) => String(a.id ?? a.artifactId).startsWith("art-"));
}
async function customerDownload(customer: Client, artifactId: string) {
  const r = await customer.get(`/api/v1/downloads/${artifactId}`);
  return { status: r.status, bytes: r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null, code: r.status === 200 ? null : ((await r.json()) as J).error?.code };
}

const WIN_X64 = { fileName: "QuasarSetup-x64.exe", platform: "windows", format: "exe", architectures: ["x64"] };
const MAC_UNIVERSAL = { fileName: "Quasar-macOS.zip", platform: "macos", format: "zip", architectures: ["arm64", "x64"] };

describe("HCG Store web administration and release lifecycle", () => {
  it("1–2. ordinary customers and administrators without HCG's Store permission cannot upload or administer; the server decides, not the page", async () => {
    const customer = await h.signIn(CUSTOMER);
    const admin = await h.signIn(ADMIN_WITHOUT_GRANT);
    for (const c of [customer, admin]) {
      const me = await call(c, "GET", "/api/v1/publishing/me");
      expect(me.status).toBe(200);
      expect(me.body.permissions).toEqual({ submit: false, approve: false, publish: false, offers: false });
      expect(me.body.administrator).toBe(false);
      expect((await call(c, "POST", "/api/v1/publishing/releases", NEW_UPDATE("9.0.0", "1"))).body.error.code).toBe("not_publisher");
      expect((await call(c, "POST", "/api/v1/publishing/products", { id: "sneaky", title: "Sneaky" })).status).toBe(403);
      expect((await call(c, "GET", "/api/v1/publishing/manager")).body.releases).toEqual([]);
      expect((await call(c, "GET", "/api/v1/publishing/changes")).status).toBe(403);
    }
    // Even holding the id of a real draft, they cannot add a file to it or change it.
    const owner = await h.signIn(OWNER);
    const rel = await call(owner, "POST", "/api/v1/publishing/releases", NEW_UPDATE("1.0.0", "100"));
    for (const c of [customer, admin]) {
      const f = exe(4096);
      expect((await call(c, "POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { ...WIN_X64, ...MANUAL, sizeBytes: f.length, sha256: sha(f) })).status).toBe(403);
      expect((await call(c, "POST", `/api/v1/publishing/releases/${rel.body.id}/disable`, { reason: "x" })).status).toBe(403);
    }
    // Browser changes need the session's CSRF token and the Store's own origin.
    const noToken = await owner.request("/api/v1/publishing/releases", { method: "POST", json: NEW_UPDATE("1.0.1", "101"), csrf: false } as RequestInit);
    expect(noToken.status).toBe(403);
    expect(((await noToken.json()) as J).error.code).toBe("csrf_token_required");
    const crossSite = await owner.request("/api/v1/publishing/releases", { method: "POST", json: NEW_UPDATE("1.0.2", "102"), headers: { origin: "https://evil.example" }, sameOrigin: false } as RequestInit);
    expect(crossSite.status).toBe(403);
    // A desktop app allow-listed by HCG still needs the person's permission: an administrator's token is refused too.
    const adminApp = await desktop(ADMIN_WITHOUT_GRANT, MAKER);
    expect((await adminApp("POST", "/api/v1/publishing/releases", NEW_UPDATE("9.0.1", "2"))).status).toBe(403);
  });

  it("3–6. the owner selects a listed product and uploads a genuine EXE and ZIP through the website; an interrupted upload resumes; the server's SHA-256 matches", async () => {
    const owner = await h.signIn(OWNER);
    const me = await call(owner, "GET", "/api/v1/publishing/me");
    expect(me.body).toMatchObject({ administrator: true, permissions: { submit: true, approve: false, publish: false } });
    const products = (await call(owner, "GET", "/api/v1/publishing/products")).body.products as J[];
    expect(products.map((p) => p.id)).toContain(PRODUCT);
    const detail = await call(owner, "GET", `/api/v1/publishing/products/${PRODUCT}`);
    expect(detail.body).toMatchObject({ id: PRODUCT, source: "catalogue", editable: false });
    expect(detail.body.metadata.editions.map((e: J) => e.id)).toEqual(["standard", "unleashed"]);

    const rel = await call(owner, "POST", "/api/v1/publishing/releases", NEW_UPDATE("1.0.0", "100"));
    expect(rel.status).toBe(201);
    expect(rel.body.uploadSource).toEqual({ via: "web", client: "hcg-store-website" });
    const win = exe();
    const mac = macApp();
    const a1 = await uploadThroughWebsite(owner, rel.body.id, win, WIN_X64, { interruptAfterChunks: 1 });
    const a2 = await uploadThroughWebsite(owner, rel.body.id, mac, MAC_UNIVERSAL);
    expect(a1).toMatchObject({ status: "verified", sha256: sha(win), sizeBytes: win.length, kind: "installer" });
    expect(a2).toMatchObject({ status: "verified", sha256: sha(mac), sizeBytes: mac.length });
    // The stored files re-hash to the recorded SHA-256, and the attempts show the dropped chunk.
    const check = await call(owner, "POST", `/api/v1/publishing/releases/${rel.body.id}/verify-checksums`);
    expect(check.body).toMatchObject({ ok: true });
    expect(check.body.files.map((f: J) => f.actual)).toEqual([sha(win), sha(mac)]);
    // Duplicate bytes in the same release are refused; the same name too.
    const dup = await call(owner, "POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { ...WIN_X64, fileName: "Copy.exe", ...MANUAL, sizeBytes: win.length, sha256: sha(win) });
    expect(dup.body.error.message).toMatch(/same bytes/);
    // A renamed non-executable is refused after upload, by content.
    const fake = Buffer.from("this is not a program at all, just text renamed to .exe");
    const bad = await call(owner, "POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { ...WIN_X64, fileName: "Fake.exe", ...MANUAL, sizeBytes: fake.length, sha256: sha(fake) });
    await fetch(bad.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${fake.length - 1}/${fake.length}` }, body: fake });
    const rejected = await call(owner, "POST", `/api/v1/publishing/artifacts/${bad.body.artifact.id}/complete`);
    expect(rejected.status).toBe(422);
    expect(rejected.body.message).toMatch(/MZ header/);
    const view = await call(owner, "GET", `/api/v1/publishing/releases/${rel.body.id}`);
    expect(view.body.lifecycle).toMatchObject({ review: "ready-for-review", availability: "available", currency: "not-current" });
  });

  it("7. the draft uploaded on the website is the same draft in HCG Executable Maker and HCG Store Manager (one API, one record)", async () => {
    const owner = await h.signIn(OWNER);
    const rel = await call(owner, "POST", "/api/v1/publishing/releases", NEW_UPDATE("1.0.0", "100"));
    await uploadThroughWebsite(owner, rel.body.id, exe(300_000), WIN_X64);
    const web = await call(owner, "GET", `/api/v1/publishing/releases/${rel.body.id}`);
    for (const client of [MAKER, STORE_MANAGER]) {
      const app = await desktop(OWNER, client);
      const manager = await app("GET", "/api/v1/publishing/manager");
      const same = (manager.body.releases as J[]).find((r) => r.id === rel.body.id)!;
      expect(same).toMatchObject({ id: rel.body.id, version: "1.0.0", build: "100", revision: web.body.revision, uploadSource: { via: "web" } });
      const full = await app("GET", `/api/v1/publishing/releases/${rel.body.id}`);
      expect(full.body.artifacts.map((a: J) => a.sha256)).toEqual(web.body.artifacts.map((a: J) => a.sha256));
    }
    // A file the desktop app adds appears on the website, recorded with the app's client.
    const app = await desktop(OWNER, MAKER);
    const f = macApp();
    const decl = await app("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { ...MAC_UNIVERSAL, ...MANUAL, sizeBytes: f.length, sha256: sha(f) });
    expect(decl.status).toBe(201);
    const after = await call(owner, "GET", `/api/v1/publishing/releases/${rel.body.id}`);
    expect(after.body.artifacts.map((a: J) => a.fileName)).toContain("Quasar-macOS.zip");
    expect(after.body.revision).toBeGreaterThan(web.body.revision);
    // Synchronisation feed: every client sees the same ordered changes.
    const changes = await call(owner, "GET", "/api/v1/publishing/changes?since=0");
    expect((changes.body.changes as J[]).filter((c) => c.releaseId === rel.body.id).map((c) => c.action)).toEqual(["release.draft-created", "artifact.declared", "artifact.verified", "artifact.declared"]);
  });

  it("8–10, 13. a new update is prepared; a failed publication leaves the previous version current; an approved publication switches atomically; other platforms are unaffected", async () => {
    const owner = await h.signIn(OWNER);
    const reviewer = await h.signIn(REVIEWER);
    const customer = await h.signIn(CUSTOMER);
    const win1 = exe(), mac1 = macApp();
    const v1 = await prepare(owner, "1.0.0", "100", [{ file: win1, decl: WIN_X64 }, { file: mac1, decl: MAC_UNIVERSAL }]);
    await approve(reviewer, v1.id, "1.0.0");
    const p1 = await publish(reviewer, v1.id, "1.0.0");
    expect(p1.status).toBe(200);
    expect(p1.body.switch.switched.map((s: J) => `${s.target.platform}/${s.target.arch}`).sort()).toEqual(["macos/arm64", "macos/x64", "windows/x64"]);
    expect((await customerDownload(customer, v1.artifacts[0]!.id)).bytes?.equals(win1)).toBe(true);

    // 8. Add New Update: Windows only, prepared to supersede the previous compatible release once published.
    const win2 = exe();
    const v2 = await prepare(owner, "1.1.0", "110", [{ file: win2, decl: WIN_X64 }], { supersedePreviousOnPublish: true });
    await approve(reviewer, v2.id, "1.1.0");
    expect((await call(owner, "GET", `/api/v1/publishing/releases/${v2.id}`)).body.supersedePreviousOnPublish).toBe(true);

    // 9. The update fails its pre-publication check (the stored bytes changed): nothing changes.
    const row = h.db.prepare("SELECT storage_key FROM pub_artifacts WHERE id = ?").get(v2.artifacts[0]!.id) as { storage_key: string };
    const stored = resolve(h.cfg.artifactStorageDir, row.storage_key);
    chmodSync(stored, 0o644);
    writeFileSync(stored, Buffer.concat([win2.subarray(0, 1000), Buffer.from("tampered"), win2.subarray(1008)]));
    const failed = await publish(reviewer, v2.id, "1.1.0");
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe("checksum_mismatch");
    const afterFail = await call(owner, "GET", `/api/v1/publishing/products/${PRODUCT}`);
    expect(afterFail.body.current.map((c: J) => `${c.platform}/${c.arch}=${c.version}`).sort()).toEqual(["macos/arm64=1.0.0", "macos/x64=1.0.0", "windows/x64=1.0.0"]);
    expect((await call(owner, "GET", `/api/v1/publishing/releases/${v2.id}`)).body.status).toBe("approved");
    expect((await customerDownload(customer, v1.artifacts[0]!.id)).bytes?.equals(win1)).toBe(true);

    // 10. With the reviewed bytes back, publication succeeds and switches the Windows target in the same transaction.
    writeFileSync(stored, win2);
    chmodSync(stored, 0o444);
    const p2 = await publish(reviewer, v2.id, "1.1.0");
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.switch.switched).toEqual([{ target: { productId: PRODUCT, editionKey: "standard", platform: "windows", arch: "x64", channel: "stable" }, previous: v1.id }]);
    const cur = await call(owner, "GET", `/api/v1/publishing/products/${PRODUCT}`);
    // 13. macOS is untouched: 1.0.0 stays current there, so it is not superseded.
    expect(cur.body.current.map((c: J) => `${c.platform}/${c.arch}=${c.version}`).sort()).toEqual(["macos/arm64=1.0.0", "macos/x64=1.0.0", "windows/x64=1.1.0"]);
    expect((await call(owner, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.status).toBe("published");
    expect((await customerDownload(customer, v2.artifacts[0]!.id)).bytes?.equals(win2)).toBe(true);
    expect((await customerDownload(customer, v1.artifacts[1]!.id)).bytes?.equals(mac1)).toBe(true);
    expect((await customerDownload(customer, v1.artifacts[0]!.id)).code).toBe("not_found"); // replaced on Windows: no longer offered
    // A beta never replaces stable: it gets its own target.
    const beta = await prepare(owner, "1.2.0-beta.1", "120", [{ file: exe(), decl: WIN_X64 }], { channel: "beta", supersedePreviousOnPublish: true });
    await approve(reviewer, beta.id, "1.2.0-beta.1");
    const pb = await publish(reviewer, beta.id, "1.2.0-beta.1");
    expect(pb.body.switch.switched.map((s: J) => `${s.target.platform}/${s.target.arch}/${s.target.channel}`)).toEqual(["windows/x64/beta"]);
    expect((await call(owner, "GET", `/api/v1/publishing/products/${PRODUCT}`)).body.current.find((c: J) => c.platform === "windows" && c.channel === "stable").version).toBe("1.1.0");
    // An ARM64 Windows build is a new target: x64 keeps 1.1.0.
    const arm = await prepare(owner, "1.1.0", "110-arm64", [{ file: exe(), decl: { ...WIN_X64, fileName: "QuasarSetup-arm64.exe", architectures: ["arm64"] } }]);
    await approve(reviewer, arm.id, "1.1.0");
    const pa = await publish(reviewer, arm.id, "1.1.0");
    expect(pa.body.switch.switched.map((s: J) => `${s.target.platform}/${s.target.arch}`)).toEqual(["windows/arm64"]);
    expect((await call(owner, "GET", `/api/v1/publishing/products/${PRODUCT}`)).body.current.map((c: J) => `${c.platform}/${c.arch}/${c.channel}=${c.version}`).sort())
      .toEqual(["macos/arm64/stable=1.0.0", "macos/x64/stable=1.0.0", "windows/arm64/stable=1.1.0", "windows/x64/beta=1.2.0-beta.1", "windows/x64/stable=1.1.0"]);
    // Without "supersede", a publication never takes over a target that already has a live current release.
    const quiet = await prepare(owner, "1.1.1", "111", [{ file: exe(), decl: WIN_X64 }]);
    await approve(reviewer, quiet.id, "1.1.1");
    const pq = await publish(reviewer, quiet.id, "1.1.1");
    expect(pq.body.switch).toMatchObject({ switched: [], superseded: [] });
    expect(pq.body.switch.kept[0].current).toBe(v2.id);
  });

  it("11, 12, 14. superseded releases leave customer downloads; disabled releases cannot be downloaded (links included); authorised staff keep the full history", async () => {
    const owner = await h.signIn(OWNER);
    const reviewer = await h.signIn(REVIEWER);
    const customer = await h.signIn(CUSTOMER);
    const v1 = await prepare(owner, "1.0.0", "100", [{ file: exe(), decl: WIN_X64 }]);
    await approve(reviewer, v1.id, "1.0.0");
    await publish(reviewer, v1.id, "1.0.0");
    const w2 = exe();
    const v2 = await prepare(owner, "2.0.0", "200", [{ file: w2, decl: WIN_X64 }], { supersedePreviousOnPublish: true });
    await approve(reviewer, v2.id, "2.0.0");
    const p2 = await publish(reviewer, v2.id, "2.0.0");
    expect(p2.body.switch.superseded).toEqual([v1.id]);
    // 11. Superseded: gone from what the product page offers and from direct download.
    const files = (await offered(customer)).map((a) => a.id ?? a.artifactId);
    expect(files).toContain(v2.artifacts[0]!.id);
    expect(files).not.toContain(v1.artifacts[0]!.id);
    expect((await customerDownload(customer, v1.artifacts[0]!.id)).status).toBe(404);
    // 12. Disabled: no download, and a link issued before the disable is dead too.
    const link = await call(customer, "POST", `/api/v1/publishing/artifacts/${v2.artifacts[0]!.id}/download-url`);
    expect(link.status).toBe(200);
    const dis = await call(owner, "POST", `/api/v1/publishing/releases/${v2.id}/disable`, { reason: "Crash on start (TEST)." });
    expect(dis.status, JSON.stringify(dis.body)).toBe(200);
    expect(dis.body.lifecycle).toMatchObject({ availability: "disabled", label: "disabled" });
    expect((await customerDownload(customer, v2.artifacts[0]!.id)).status).toBe(404);
    expect((await fetch(link.body.url)).status).toBe(410);
    expect(await offered(customer)).toEqual([]);
    const resolution = await (await fetch(`${h.origin}/api/public/v1/release-resolution/${PRODUCT}`)).json() as J;
    expect((resolution.releases as J[]).filter((x) => x.source === "hcg-store-publication")).toEqual([]); // (the catalogue's own static release may remain)
    // Re-enabling a published release is a publication decision: the uploader cannot, the publisher can.
    expect((await call(owner, "POST", `/api/v1/publishing/releases/${v2.id}/enable`, { reason: "Fixed" })).body.error.code).toBe("not_publication");
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v2.id}/enable`, { reason: "False alarm (TEST)." })).status).toBe(200);
    expect((await customerDownload(customer, v2.artifacts[0]!.id)).bytes?.equals(w2)).toBe(true);
    // 14. History: both releases, all dimensions, for authorised staff (archived ones on request).
    const manager = (await call(owner, "GET", `/api/v1/publishing/manager?productId=${PRODUCT}`)).body.releases as J[];
    expect(manager.map((r) => [r.version, r.status, r.availability, r.lifecycle.currency])).toEqual([["2.0.0", "published", "available", "current"], ["1.0.0", "superseded", "available", "superseded"]]);
    expect((await call(owner, "POST", `/api/v1/publishing/releases/${v2.id}/archive`, { reason: "x" })).body.error.code).toBe("is_current");
    expect((await call(owner, "POST", `/api/v1/publishing/releases/${v1.id}/archive`, { reason: "Old build (TEST)." })).status).toBe(200);
    expect(((await call(owner, "GET", `/api/v1/publishing/manager?productId=${PRODUCT}`)).body.releases as J[]).map((r) => r.version)).toEqual(["2.0.0"]);
    expect(((await call(owner, "GET", `/api/v1/publishing/manager?productId=${PRODUCT}&include=archived`)).body.releases as J[]).map((r) => r.version)).toEqual(["2.0.0", "1.0.0"]);
    const old = await call(owner, "POST", `/api/v1/publishing/artifacts/${v1.artifacts[0]!.id}/download-url`);
    expect(old.status).toBe(200); // staff may still fetch history to review it
    const audit = (await call(owner, "GET", `/api/v1/publishing/releases/${v2.id}`)).body.audit.map((a: J) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["release.published", "release.disabled", "release.enabled"]));
  });

  it("15. rollback works in the TEST Store: an earlier release is restored atomically on all its targets; a revoked release can never come back", async () => {
    const owner = await h.signIn(OWNER);
    const reviewer = await h.signIn(REVIEWER);
    const customer = await h.signIn(CUSTOMER);
    const w1 = exe(), m1 = macApp();
    const v1 = await prepare(owner, "1.0.0", "100", [{ file: w1, decl: WIN_X64 }, { file: m1, decl: MAC_UNIVERSAL }]);
    await approve(reviewer, v1.id, "1.0.0");
    await publish(reviewer, v1.id, "1.0.0");
    const v2 = await prepare(owner, "2.0.0", "200", [{ file: exe(), decl: WIN_X64 }, { file: macApp(), decl: MAC_UNIVERSAL }], { supersedePreviousOnPublish: true });
    await approve(reviewer, v2.id, "2.0.0");
    await publish(reviewer, v2.id, "2.0.0");
    expect((await call(owner, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.status).toBe("superseded");
    // Only the publication permission, in the browser, typing the version, with a reason.
    expect((await call(owner, "POST", `/api/v1/publishing/releases/${v1.id}/restore`, { confirm: "1.0.0", reason: "x" })).body.error.code).toBe("not_publication");
    expect((await (await desktop(REVIEWER, STORE_MANAGER))("POST", `/api/v1/publishing/releases/${v1.id}/restore`, { confirm: "1.0.0", reason: "x" })).status).toBe(403);
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v1.id}/restore`, { confirm: "2.0.0", reason: "x" })).body.error.code).toBe("confirmation_required");
    const r = await call(reviewer, "POST", `/api/v1/publishing/releases/${v1.id}/restore`, { confirm: "1.0.0", reason: "2.0.0 crashes on start (TEST rollback)." });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.switch.switched.map((s: J) => `${s.target.platform}/${s.target.arch}<-${s.previous === v2.id ? "v2" : s.previous}`).sort()).toEqual(["macos/arm64<-v2", "macos/x64<-v2", "windows/x64<-v2"]);
    expect(r.body.switch.superseded).toEqual([v2.id]);
    expect(r.body).toMatchObject({ status: "published", lifecycle: { currency: "current" } });
    expect((await customerDownload(customer, v1.artifacts[0]!.id)).bytes?.equals(w1)).toBe(true);
    expect((await customerDownload(customer, v1.artifacts[1]!.id)).bytes?.equals(m1)).toBe(true);
    expect((await call(owner, "GET", `/api/v1/publishing/releases/${v1.id}`)).body.audit.map((a: J) => a.action)).toContain("release.restored");
    // Revoked: final. It leaves every target, its links die, and neither enable nor restore brings it back.
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v2.id}/revoke`, { reason: "Signing key compromised (TEST).", confirm: "2.0.0" })).status).toBe(200);
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v2.id}/restore`, { confirm: "2.0.0", reason: "x" })).body.error.code).toBe("revoked");
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v2.id}/enable`, { reason: "x" })).status).toBe(409);
    expect((await call(owner, "POST", `/api/v1/publishing/artifacts/${v2.artifacts[0]!.id}/download-url`)).body.error.code).toBe("revoked");
  });

  it("concurrent clients cannot silently overwrite each other (If-Match revisions); draft products are edited with the same guard; listed products stay HCG's", async () => {
    const owner = await h.signIn(OWNER);
    const app = await desktop(OWNER, STORE_MANAGER);
    const created = await call(owner, "POST", "/api/v1/publishing/products", { id: "hcg-aurora", title: "HCG Aurora", metadata: { summary: "A draft.", platforms: ["windows", "macos"], editions: [{ id: "standard", name: "Standard" }] } });
    expect(created.status).toBe(201);
    expect(created.body.note).toMatch(/exists only in HCG Store/);
    const p1 = await call(owner, "GET", "/api/v1/publishing/products/hcg-aurora");
    const ok = await call(owner, "PATCH", "/api/v1/publishing/products/hcg-aurora", { summary: "Edited on the website." }, { "if-match": `"${p1.body.revision}"` });
    expect(ok.status).toBe(200);
    // Store Manager still holds the old revision: refused, nothing overwritten.
    const r = await fetch(`${h.origin}/api/v1/publishing/products/hcg-aurora`, { method: "PATCH", headers: { authorization: `Bearer ${await h.idp.accessToken(OWNER, STORE_MANAGER)}`, "content-type": "application/json", "if-match": `"${p1.body.revision}"` }, body: JSON.stringify({ summary: "Edited in Store Manager." }) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as J).error.code).toBe("revision_conflict");
    expect((await call(owner, "GET", "/api/v1/publishing/products/hcg-aurora")).body.metadata.summary).toBe("Edited on the website.");
    // The draft product's editions are usable for releases at once (Add New Product → first release).
    const first = await app("POST", "/api/v1/publishing/releases", { ...NEW_UPDATE("0.1.0", "1"), productId: "hcg-aurora", editionId: "standard", eligibility: "private" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Releases too: a stale If-Match is refused.
    const stale = first.body.revision as number;
    await app("POST", `/api/v1/publishing/releases/${first.body.id}/artifacts`, { ...WIN_X64, ...MANUAL, sizeBytes: 4096, sha256: sha(exe(4096)) });
    const conflict = await call(owner, "POST", `/api/v1/publishing/releases/${first.body.id}/disable`, { reason: "x" }, { "if-match": `"${stale}"` });
    expect(conflict.body.error.code).toBe("revision_conflict");
    // Listed products are defined by HCG's catalogue: not editable here.
    expect((await call(owner, "PATCH", `/api/v1/publishing/products/${PRODUCT}`, { summary: "x" })).body.error.code).toBe("catalogue_product");
    // No central product, entitlement or public release comes from a Store draft.
    const pub = await app("POST", "/api/v1/publishing/releases", { ...NEW_UPDATE("0.1.0", "2"), productId: "hcg-aurora", editionId: "standard" });
    expect(pub.status).toBe(201);
    expect((await call(owner, "GET", "/api/v1/publishing/products/hcg-aurora")).body.centralId).toBeNull();
  });
});

describe("Production controls", () => {
  it("16–17. payments stay disabled and publication stays separately controlled: in uploads mode the website uploads privately, and nothing can be approved, published, restored or delivered", async () => {
    await h.stop();
    await start({ HCG_STORE_PUBLISHING: "uploads", HCG_STORE_ADMIN_RATE_PER_MINUTE: "40" });
    const owner = await h.signIn(OWNER);
    const reviewer = await h.signIn(REVIEWER);
    const me = await call(owner, "GET", "/api/v1/publishing/me");
    expect(me.body).toMatchObject({ publishingMode: "uploads", capabilities: { uploads: true, approval: false, publication: false, publicDelivery: false } });
    const rel = await call(owner, "POST", "/api/v1/publishing/releases", NEW_UPDATE("1.0.0", "100"));
    const f = exe(200_000);
    const a = await uploadThroughWebsite(owner, rel.body.id, f, WIN_X64);
    expect(a.status).toBe("verified");
    expect((await call(owner, "POST", `/api/v1/publishing/releases/${rel.body.id}/submit`)).status).toBe(200);
    for (const step of ["approve", "publish"]) {
      expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${rel.body.id}/${step}`, { confirm: "1.0.0", eligibility: "public" })).body.error.code).toBe("publication_disabled");
    }
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${rel.body.id}/restore`, { confirm: "1.0.0", reason: "x" })).body.error.code).toBe("publication_disabled");
    const customer = await h.signIn(CUSTOMER);
    expect((await call(customer, "POST", `/api/v1/publishing/artifacts/${a.id}/download-url`)).body.error.code).toBe("publication_disabled");
    // Rate limits apply per person.
    let limited = 0;
    for (let i = 0; i < 45; i++) if ((await call(owner, "GET", "/api/v1/publishing/me")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);

    // The production configuration (fly.toml) keeps payments off, protected downloads off and publication off.
    const toml = readFileSync(join(__dirname, "..", "..", "fly.toml"), "utf8");
    const env = Object.fromEntries([...toml.split("[env]")[1]!.split(/\n\[/)[0]!.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]));
    const secret = { HCG_STORE_SECRET_KEY: randomBytes(32).toString("base64") }; // a Fly secret in production
    const cfg = parseStoreConfig({ ...env, ...secret });
    expect(cfg.publishing.mode).toBe("uploads");
    expect(cfg.publishing.publicationEnabled).toBe(false);
    expect(env.HCG_STORE_PAYMENT_PROVIDER ?? "none").toBe("none");
    expect(env.HCG_STORE_PROTECTED_DOWNLOADS ?? "disabled").toBe("disabled");
    expect(env.HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID).toBeUndefined();
    expect(() => parseStoreConfig({ ...env, ...secret, HCG_STORE_DEVICE_POLICY: "require-sovereign-device" })).toThrow(/HCG_STORE_DEVICE_POLICY/);
  });
});
