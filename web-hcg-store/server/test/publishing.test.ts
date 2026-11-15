// @vitest-environment node
/**
 * Ship to Store: publishing, upload, validation, approval, delivery and rollback, against the real server code with
 * the mock HCG Connect provider and the TEST entitlement ledger (which stands in for HCG's central authority).
 */
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Client, type Harness } from "./harness";

const MAKER_CLIENT = "99999999-8888-4777-8666-555555555555";
const PUBLISHER = { sub: "user-publisher", email: "pub@example.test", name: "Publisher" };
const APPROVER = { sub: "user-approver", email: "approver@example.test", name: "Approver" };
const BUYER = { sub: "user-buyer", email: "buyer@example.test", name: "Buyer" };
const STRANGER = { sub: "user-stranger", email: "x@example.test", name: "Stranger", role: "admin" };
const PRODUCT = "fixture-quasar-shell";

let h: Harness;
let ledger: TestLedgerAuthority;
beforeEach(async () => {
  h = await startHarness({
    env: {
      HCG_STORE_PUBLISHING: "enabled",
      HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER_CLIENT,
      HCG_STORE_PUBLISHER_CENTRAL_ID: "hcg.store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "hcg.store.approve",
      HCG_STORE_UPLOAD_CHUNK_MB: "1",
    },
  });
  h.idp.otherClients.add(MAKER_CLIENT);
  ledger = h.authority as TestLedgerAuthority;
  // HCG's decisions (central permissions), stood in for by the TEST ledger.
  ledger.grant(PUBLISHER.sub, "hcg.store.publish", "*", "test", null);
  ledger.grant(APPROVER.sub, "hcg.store.approve", "*", "test", null);
});
afterEach(async () => {
  await h.stop();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A minimal, valid IPA (ZIP with Payload/App.app/Info.plist and a code signature file). */
function ipa(extra: { name: string; data?: Buffer }[] = []): Buffer {
  const files = [{ name: "Payload/Sample.app/Info.plist", data: Buffer.from("<plist><dict/></plist>") }, { name: "Payload/Sample.app/_CodeSignature/CodeResources", data: Buffer.from("x") }, ...extra];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = f.data ?? Buffer.from("x");
    const comp = deflateRawSync(data);
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
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


function tar(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(f.data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

/** A minimal Debian package (ar: debian-binary, control.tar.gz with ./control, data.tar.gz). */
function deb(pkg: string, version: string, arch: string): Buffer {
  const member = (name: string, data: Buffer) => {
    const h = Buffer.alloc(60, " ");
    h.write(name, 0); h.write("0", 16); h.write("0", 28); h.write("0", 34); h.write("100644", 40); h.write(String(data.length), 48); h.write("`\n", 58);
    return Buffer.concat([h, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
  };
  const control = gzipSync(tar([{ name: "./control", data: Buffer.from(`Package: ${pkg}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: HCG\nDescription: sample\n`) }]));
  const data = gzipSync(tar([{ name: "./usr/bin/sample", data: Buffer.from("#!/bin/sh\necho sample\n") }]));
  return Buffer.concat([Buffer.from("!<arch>\n"), member("debian-binary", Buffer.from("2.0\n")), member("control.tar.gz", control), member("data.tar.gz", data)]);
}

class Desktop {
  constructor(private readonly token: string) {}
  async call(method: string, path: string, body?: unknown) {
    const r = await fetch(h.origin + path, { method, headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }
}

async function desktop(user = PUBLISHER, client = MAKER_CLIENT) {
  return new Desktop(await h.idp.accessToken(user, client));
}

const RELEASE = { productId: PRODUCT, editionId: "standard", version: "1.2.0", build: "42", releaseNotes: ["First Ship to Store build."], compatibility: { minimumOs: { ios: "15.0" }, architectures: ["arm64"], notes: [] }, distribution: "paid", eligibility: "public" };

async function upload(d: Desktop, releaseId: string, file: Buffer, name = "Sample-1.2.0.ipa", declared = sha(file)) {
  const a = await d.call("POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { fileName: name, platform: "ios", format: "ipa", sizeBytes: file.length, sha256: declared, signing: { status: "signed", evidence: "codesign --verify: valid", tool: "HCG Executable Maker" } });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const chunk = a.body.chunkBytes as number;
  for (let start = 0; start < file.length; start += chunk) {
    const end = Math.min(file.length, start + chunk) - 1;
    const r = await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${start}-${end}/${file.length}` }, body: file.subarray(start, end + 1) });
    expect(r.status).toBe(200);
  }
  return { id: a.body.artifact.id as string, uploadUrl: a.body.uploadUrl as string, complete: () => d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`) };
}

async function fetchDownload(d: Desktop | Client, artifactId: string) {
  const r = d instanceof Desktop ? await d.call("POST", `/api/v1/publishing/artifacts/${artifactId}/download-url`) : await (async () => {
    const x = await d.post(`/api/v1/publishing/artifacts/${artifactId}/download-url`);
    return { status: x.status, body: (await x.json()) as Record<string, any> };
  })();
  if (r.status !== 200) return { status: r.status, body: r.body };
  const f = await fetch(r.body.url);
  return { status: f.status, bytes: Buffer.from(await f.arrayBuffer()), url: r.body.url as string };
}

describe("Ship to Store", () => {
  it("authenticates desktop tokens from allow-listed HCG Connect clients only, and HCG decides who may publish", async () => {
    expect((await (await desktop()).call("GET", "/api/v1/publishing/whoami")).status).toBe(200);
    expect((await (await desktop(PUBLISHER, h.idp.clientId)).call("GET", "/api/v1/publishing/whoami")).status).toBe(401); // the Store's own client
    expect((await (await desktop(PUBLISHER, "00000000-0000-4000-8000-000000000000")).call("GET", "/api/v1/publishing/whoami")).status).toBe(401);
    const real = await h.idp.accessToken(PUBLISHER, MAKER_CLIENT);
    const at = real.lastIndexOf(".") + 5;
    const forged = real.slice(0, at) + (real[at] === "A" ? "B" : "A") + real.slice(at + 1);
    expect((await new Desktop(forged).call("GET", "/api/v1/publishing/whoami")).status).toBe(401);
    expect((await fetch(h.origin + "/api/v1/publishing/whoami")).status).toBe(401);
    // An HCG admin role is not a publishing permission.
    const admin = await desktop(STRANGER);
    expect((await admin.call("POST", "/api/v1/publishing/releases", RELEASE)).status).toBe(403);
    expect((await admin.call("GET", "/api/v1/publishing/products")).body.products).toEqual([]);
  });

  it("creates a private draft, uploads in chunks, verifies the SHA-256 and stores the file immutably", async () => {
    const d = await desktop();
    const products = (await d.call("GET", "/api/v1/publishing/products")).body.products as { id: string }[];
    expect(products.map((p) => p.id)).toContain(PRODUCT);
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    expect(rel.status).toBe(201);
    expect(rel.body.status).toBe("draft");
    const file = ipa([{ name: "Payload/Sample.app/Sample", data: randomBytes(2_500_000) }]);
    const up = await upload(d, rel.body.id, file);
    const done = await up.complete();
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.artifact.status).toBe("verified");
    expect(done.body.artifact.sha256).toBe(sha(file));
    expect(done.body.artifact.validation.signatureStructure).toBe("present");
    // The uploader (a publisher) can fetch it back through a short-lived URL; the bytes are identical.
    const dl = await fetchDownload(d, up.id);
    expect(dl.status).toBe(200);
    expect(sha((dl as { bytes: Buffer }).bytes)).toBe(sha(file));
    // Same version and build again: refused (releases are immutable).
    expect((await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" })).status).toBe(409);
    // The audit chain is intact and records each step.
    const view = await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`);
    expect(view.body.auditIntact).toBe(true);
    expect(view.body.audit.map((a: { action: string }) => a.action)).toEqual(["release.draft-created", "artifact.declared", "artifact.verified", "artifact.downloaded"]);
  });

  it("rejects a hash mismatch, a wrong format and unsafe archive paths, and lets the draft recover", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    const file = ipa();
    const wrong = await upload(d, rel.body.id, file, "Wrong.ipa", "0".repeat(64));
    const r1 = await wrong.complete();
    expect(r1.status).toBe(422);
    expect(r1.body.message).toContain("SHA-256 mismatch");
    const traversal = ipa([{ name: "Payload/../../etc/evil" }]);
    const r2 = await (await upload(d, rel.body.id, traversal, "Evil.ipa")).complete();
    expect(r2.status).toBe(422);
    expect(r2.body.message).toContain("leaves the archive");
    const notIpa = Buffer.from("MZ this is not an ipa");
    const r3 = await (await upload(d, rel.body.id, notIpa, "Fake.ipa")).complete();
    expect(r3.status).toBe(422);
    // Unsupported types and path tricks are refused before any byte is accepted.
    for (const fileName of ["../x.ipa", "a/b.ipa", "x.ipa.sh", "x .ipa"]) {
      expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName, platform: "ios", format: "ipa", sizeBytes: 10, sha256: "a".repeat(64) })).status).toBe(400);
    }
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "x.apk", platform: "android", format: "apk", sizeBytes: 10, sha256: "a".repeat(64) })).status).toBe(400);
    // Recovery: remove the rejected files and upload the right one.
    for (const id of [wrong.id]) expect((await d.call("DELETE", `/api/v1/publishing/artifacts/${id}`)).status).toBe(200);
    expect((await (await upload(d, rel.body.id, file, "Good.ipa")).complete()).status).toBe(200);
  });

  it("resumes an interrupted upload at the last good byte and renews an expired upload URL", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    const file = ipa([{ name: "Payload/Sample.app/Big", data: randomBytes(1_800_000) }]);
    const a = await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "Resume.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file) });
    const chunk = a.body.chunkBytes as number;
    // First chunk arrives; the second is "lost" (sent short), then the URL expires.
    const first = await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${chunk - 1}/${file.length}` }, body: file.subarray(0, chunk) });
    expect(first.status, await first.clone().text()).toBe(200);
    const short = await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${chunk}-${file.length - 1}/${file.length}` }, body: file.subarray(chunk, chunk + 1000) });
    expect(short.status).toBe(400);
    const wrongOffset = await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-9/${file.length}` }, body: file.subarray(0, 10) });
    expect(wrongOffset.status).toBe(409);
    expect(((await wrongOffset.json()) as { received: number }).received).toBe(chunk);
    h.clock.advance(901);
    expect((await fetch(a.body.uploadUrl, { method: "GET" })).status).toBe(403);
    const renewed = await d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/upload-url`);
    expect(renewed.body.received).toBe(chunk);
    expect((await fetch(renewed.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${chunk}-${file.length - 1}/${file.length}` }, body: file.subarray(chunk) })).status).toBe(200);
    const done = await d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`);
    expect(done.body.artifact.sha256).toBe(sha(file));
  });

  it("needs a MANUAL approval in the Store (browser session, another person, typed confirmation) before public delivery, which then requires the entitlement", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", RELEASE);
    const file = ipa();
    const up = await upload(d, rel.body.id, file);
    expect((await up.complete()).status).toBe(200);
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`)).body.status).toBe("submitted");
    // A desktop app cannot approve, not even with an approver's token.
    const approverDesktop = await desktop(APPROVER);
    expect((await approverDesktop.call("POST", `/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.2.0" })).status).toBe(403);
    // The publisher cannot approve their own release in the browser either (no approver permission).
    const pubWeb = await h.signIn(PUBLISHER);
    expect((await pubWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.2.0" })).status).toBe(403);
    // Buyers cannot fetch it before approval.
    const buyer = await desktop(BUYER);
    expect((await fetchDownload(buyer, up.id)).status).toBe(403);
    const approverWeb = await h.signIn(APPROVER);
    // Cross-site requests are refused; a missing confirmation is refused.
    expect((await approverWeb.request(`/api/v1/publishing/releases/${rel.body.id}/approve`, { method: "POST", json: { eligibility: "public", confirm: "1.2.0" }, headers: { origin: "https://evil.example" }, sameOrigin: false })).status).toBe(403);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "" })).status).toBe(400);
    const review = await approverWeb.get(`/publishing/releases/${rel.body.id}`);
    expect(review.status).toBe(200);
    const page = await review.text();
    expect(page).toContain(sha(file));
    expect(page).toContain("1.2.0");
    expect(page).toContain("build 42");
    const ok = await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.2.0" });
    expect(ok.status).toBe(200);
    // Paid public release: no entitlement → refused; entitlement (granted by HCG) → the exact bytes.
    expect((await fetchDownload(buyer, up.id)).status).toBe(403);
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const dl = await fetchDownload(buyer, up.id);
    expect(dl.status).toBe(200);
    expect(sha((dl as { bytes: Buffer }).bytes)).toBe(sha(file));
    // The existing protected-delivery path offers it too (library/product access).
    const buyerWeb = await h.signIn(BUYER);
    const access = (await (await buyerWeb.get(`/api/v1/products/${PRODUCT}/access?edition=standard`)).json()) as { editions: { artifacts: { id: string }[] }[] };
    expect(access.editions[0]!.artifacts.map((a) => a.id)).toContain(up.id);
    // Revocation applies to the next request; an issued link is re-checked when used.
    const link = await buyer.call("POST", `/api/v1/publishing/artifacts/${up.id}/download-url`);
    ledger.revokeAll(BUYER.sub);
    expect((await fetch(link.body.url)).status).toBe(403);
    // Expired links are refused.
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const link2 = await buyer.call("POST", `/api/v1/publishing/artifacts/${up.id}/download-url`);
    h.clock.advance(121);
    expect((await fetch(link2.body.url)).status).toBe(403);
  });

  it("rolls back: a withdrawn release stops delivering at once, keeps its files and history, and cannot be edited", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, distribution: "free" });
    const up = await upload(d, rel.body.id, ipa());
    await up.complete();
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const approverWeb = await h.signIn(APPROVER);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.2.0" })).status).toBe(200);
    const anyone = await desktop(BUYER);
    const link = await anyone.call("POST", `/api/v1/publishing/artifacts/${up.id}/download-url`);
    expect(link.status).toBe(200); // free + public: any signed-in HCG account
    expect((await fetch(h.origin + `/api/v1/publishing/artifacts/${up.id}/download-url`, { method: "POST" })).status).toBe(401); // signed out
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/withdraw`, { reason: "Crash on launch (rollback)." })).body.status).toBe("withdrawn");
    expect((await fetch(link.body.url)).status).toBe(410);
    expect((await d.call("DELETE", `/api/v1/publishing/artifacts/${up.id}`)).status).toBe(409);
    const view = await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`);
    expect(view.body.artifacts[0].status).toBe("verified");
    expect(view.body.auditIntact).toBe(true);
    expect(view.body.audit.at(-1).action).toBe("release.withdrawn");
  });

  it("keeps artifacts immutable and the audit log append-only at the database level", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    const up = await upload(d, rel.body.id, ipa());
    await up.complete();
    const db = h.app.deps.db;
    expect(() => db.prepare("UPDATE pub_artifacts SET sha256 = ? WHERE id = ?").run("f".repeat(64), up.id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM pub_artifacts WHERE id = ?").run(up.id)).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE pub_audit SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM pub_audit").run()).toThrow(/append-only/);
  });

  it("draft products stay private: public approval needs a catalogue product with a central ID", async () => {
    const d = await desktop();
    expect((await d.call("POST", "/api/v1/publishing/products", { id: "sample-tool", title: "Sample Tool" })).status).toBe(201);
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, productId: "sample-tool", editionId: null });
    expect(rel.status).toBe(201);
    await (await upload(d, rel.body.id, ipa())).complete();
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const approverWeb = await h.signIn(APPROVER);
    const r = await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.2.0" });
    expect(r.status).toBe(409);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "internal-testing", confirm: "1.2.0" })).status).toBe(200);
  });
  it("HCG Repo destination: the package's control file must match the catalogue mapping; Sileo can deliver it only after public approval", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, editionId: "unleashed", version: "1.0.1", compatibility: { minimumOs: {}, architectures: ["iphoneos-arm64"], notes: [] }, destinations: ["hcg-store", "hcg-repo"] });
    expect(rel.status, JSON.stringify(rel.body)).toBe(201);
    const declare = (file: Buffer, name: string, pkg: { id: string; version: string; architecture: string } | null) =>
      d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: name, platform: "linux", format: "deb", sizeBytes: file.length, sha256: sha(file), architectures: ["iphoneos-arm64"], package: pkg });
    const good = deb("com.example.fixture.quasar.unleashed", "1.0.1", "iphoneos-arm64");
    expect((await declare(good, "q.deb", null)).status).toBe(400); // HCG Repo needs the control fields declared
    const send = async (file: Buffer, name: string, pkg: { id: string; version: string; architecture: string }) => {
      const a = await declare(file, name, pkg);
      expect(a.status).toBe(201);
      expect((await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(200);
      return d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`);
    };
    const lying = await send(deb("com.example.other", "1.0.1", "iphoneos-arm64"), "other.deb", { id: "com.example.fixture.quasar.unleashed", version: "1.0.1", architecture: "iphoneos-arm64" });
    expect(lying.status).toBe(422);
    expect(lying.body.message).toContain("not what was declared");
    const unmapped = await send(deb("com.example.other", "1.0.1", "iphoneos-arm64"), "other2.deb", { id: "com.example.other", version: "1.0.1", architecture: "iphoneos-arm64" });
    expect(unmapped.body.message).toContain("not mapped");
    const ok = await send(good, "quasar_1.0.1_iphoneos-arm64.deb", { id: "com.example.fixture.quasar.unleashed", version: "1.0.1", architecture: "iphoneos-arm64" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.artifact.validation.content.debian).toMatchObject({ package: "com.example.fixture.quasar.unleashed", version: "1.0.1", architecture: "iphoneos-arm64", controlReadable: true });
    // Not delivered through the Store's package paths before approval…
    expect(h.app.publishing.publishedFor("fixture-quasar-shell", "unleashed")).toEqual([]);
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const approverWeb = await h.signIn(APPROVER);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "1.0.1" })).status).toBe(200);
    // …and only then, as a normal entitlement-gated Store artifact with its version and layout for Sileo.
    expect(h.app.publishing.publishedFor("fixture-quasar-shell", "unleashed").map((a) => a.id)).toEqual([ok.body.artifact.id]);
    expect(h.app.publishing.publishedMeta(ok.body.artifact.id)).toEqual({ version: "1.0.1", architectures: ["iphoneos-arm64"] });
  });
});
