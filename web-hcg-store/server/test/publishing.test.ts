// @vitest-environment node
/**
 * Ship to Store: publishing, upload, validation, approval, delivery and rollback, against the real server code with
 * the mock HCG Connect provider and the TEST entitlement ledger (which stands in for HCG's central authority).
 */
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCatalogue } from "../../src/domain/catalogue";
import { exportReleaseRecords } from "../src/release-records";
import { openWindow } from "../src/free-windows";
import { syncReleases } from "../src/release-sync";
import { FIXTURE_CATALOGUE, startHarness, type Client, type Harness } from "./harness";

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
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
      HCG_STORE_UPLOAD_CHUNK_MB: "1",
    },
  });
  h.idp.otherClients.add(MAKER_CLIENT);
  ledger = h.authority as TestLedgerAuthority;
  // HCG's decisions (central permissions), stood in for by the TEST ledger.
  ledger.grant(PUBLISHER.sub, "*", featureEdition("store.publish"), "test", null);
  ledger.grant(APPROVER.sub, "*", featureEdition("store.release.approve"), "test", null);
  // Publication is HCG's separate permission; the approver in these tests also holds it unless a test says otherwise.
  ledger.grant(APPROVER.sub, "*", featureEdition("store.release.publish"), "test", null);
});
afterEach(async () => {
  await h.stop();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A provisioning profile as Apple ships it: a CMS envelope around an XML plist (the envelope is not checked here). */
function profile(kind: "ad-hoc" | "development" | "enterprise" | "app-store"): Buffer {
  const keys = kind === "enterprise" ? "<key>ProvisionsAllDevices</key><true/>"
    : kind === "app-store" ? "" : `<key>ProvisionedDevices</key><array><string>00008110-000000000000001E</string></array><key>Entitlements</key><dict><key>get-task-allow</key>${kind === "development" ? "<true/>" : "<false/>"}</dict>`;
  return Buffer.concat([randomBytes(64), Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Name</key><string>Sample ${kind}</string><key>ExpirationDate</key><date>2027-11-16T00:00:00Z</date>${keys}</dict></plist>`), randomBytes(64)]);
}

/** A minimal, valid IPA (ZIP with Payload/App.app/Info.plist, a code signature file and an ad hoc profile). */
function ipa(extra: { name: string; data?: Buffer }[] = [], opts: { signed?: boolean; profile?: Parameters<typeof profile>[0] | null; simulator?: boolean } = {}): Buffer {
  const info = opts.simulator ? "<plist><dict><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array><key>DTPlatformName</key><string>iphonesimulator</string></dict></plist>" : "<plist><dict><key>DTPlatformName</key><string>iphoneos</string></dict></plist>";
  const files = [{ name: "Payload/Sample.app/Info.plist", data: Buffer.from(info) },
    ...(opts.signed === false ? [] : [{ name: "Payload/Sample.app/_CodeSignature/CodeResources", data: Buffer.from("x") }]),
    ...(opts.profile === null || opts.signed === false ? [] : [{ name: "Payload/Sample.app/embedded.mobileprovision", data: profile(opts.profile ?? "ad-hoc") }]), ...extra];
  return zip(files);
}

/** A ZIP archive; `beforeCentralDirectory` is placed between the entries and the central directory (APK Signing Block). */
function zip(files: { name: string; data?: Buffer }[], beforeCentralDirectory: Buffer = Buffer.alloc(0)): Buffer {
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
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset + beforeCentralDirectory.length, 16);
  return Buffer.concat([...locals, beforeCentralDirectory, cd, end]);
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

/** Build provenance every file needs before submission (Executable Maker reports it). */
const PROV = { sourceCommit: "0123abcd", buildProvider: "github-actions", toolchain: "Xcode 17.0 (test)" };

const RELEASE = { productId: PRODUCT, editionId: "standard", version: "1.2.0", build: "42", releaseNotes: ["First Ship to Store build."], compatibility: { minimumOs: { ios: "15.0" }, architectures: ["arm64"], notes: [] }, distribution: "paid", eligibility: "public" };

async function upload(d: Desktop, releaseId: string, file: Buffer, name = "Sample-1.2.0.ipa", declared = sha(file)) {
  const a = await d.call("POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { fileName: name, platform: "ios", ...PROV, format: "ipa", sizeBytes: file.length, sha256: declared, signing: { status: "signed", evidence: "codesign --verify: valid", tool: "HCG Executable Maker" } });
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

  it("checks HCG's personal grants on hcg.store, never ownership, a role, or a grant on another product", async () => {
    const SCOPED = { sub: "user-scoped", email: "scoped@example.test", name: "Scoped" };
    // A store.publish grant on the published product's own central ID is not HCG's contract: it permits nothing.
    ledger.grant(SCOPED.sub, "fixture.quasar.shell", featureEdition("store.publish"), "test", null);
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const scoped = await desktop(SCOPED);
    expect((await scoped.call("GET", "/api/v1/publishing/products")).body.products).toEqual([]);
    expect((await scoped.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" })).body.error.code).toBe("not_publisher");
    // Owning the product (the download licence) is not permission to publish it; neither is a role.
    const buyer = await desktop(BUYER);
    expect((await buyer.call("POST", "/api/v1/publishing/releases", { ...RELEASE, build: "77", eligibility: "private" })).body.error.code).toBe("not_publisher");
    // The personal grant on hcg.store permits publishing (catalogue products and draft products alike).
    ledger.grant(SCOPED.sub, "hcg.store", featureEdition("store.publish"), "test", null);
    const other = { ...RELEASE, productId: "fixture-orbit-notes", editionId: null, eligibility: "private" };
    expect((await scoped.call("POST", "/api/v1/publishing/releases", other)).status).toBe(201);
    expect((await scoped.call("POST", "/api/v1/publishing/releases", { ...RELEASE, build: "78", eligibility: "private" })).status).toBe(201);
    expect((await scoped.call("POST", "/api/v1/publishing/products", { id: "scoped-draft", title: "Scoped draft" })).status).toBe(201);
    // The approver permission is a different grant: publishing rights do not approve.
    const web = await h.signIn(SCOPED);
    const rel = (await scoped.call("GET", `/api/v1/publishing/releases?productId=${PRODUCT}`)).body.releases[0];
    expect((await web.post(`/api/v1/publishing/releases/${rel.id}/approve`, { eligibility: "private", confirm: rel.version })).status).toBe(403);
    // Revoking the grant takes effect on the next request (checked fresh every time, never cached).
    ledger.revokeAll(SCOPED.sub);
    expect((await scoped.call("POST", "/api/v1/publishing/releases", { ...RELEASE, build: "79", eligibility: "private" })).body.error.code).toBe("not_publisher");
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
    // Same request again (a lost response, a retry): the same draft comes back, no duplicate.
    const again = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    expect([again.status, again.body.id, again.body.reused]).toEqual([200, rel.body.id, true]);
    // Same version and build with different details: refused, naming the draft to continue.
    const changed = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "public" });
    expect([changed.status, changed.body.error.code]).toEqual([409, "draft_exists"]);
    expect(changed.body.error.message).toContain(rel.body.id);
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
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "x.exe", platform: "android", format: "exe", sizeBytes: 10, sha256: "a".repeat(64) })).status).toBe(400);
    // Recovery: remove the rejected files and upload the right one.
    for (const id of [wrong.id]) expect((await d.call("DELETE", `/api/v1/publishing/artifacts/${id}`)).status).toBe(200);
    expect((await (await upload(d, rel.body.id, file, "Good.ipa")).complete()).status).toBe(200);
  });

  it("resumes an interrupted upload at the last good byte and renews an expired upload URL", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "private" });
    const file = ipa([{ name: "Payload/Sample.app/Big", data: randomBytes(1_800_000) }]);
    const a = await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "Resume.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file), ...PROV });
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
    // Approved is not yet published: nothing is delivered to customers until a person publishes it explicitly.
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    expect((await fetchDownload(buyer, up.id)).status).toBe(403);
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "1.2.0" })).status).toBe(403); // never from a desktop app
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "" })).status).toBe(400);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "1.2.0" })).status).toBe(200);
    ledger.revokeAll(BUYER.sub);
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
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "1.2.0" })).status).toBe(200);
    const anyone = await desktop(BUYER);
    // Free and public, but no free testing window is open (and the edition is not permanently free): not delivered.
    expect((await anyone.call("POST", `/api/v1/publishing/artifacts/${up.id}/download-url`)).body.error.code).toBe("free_period_closed");
    openWindow(h.db, { productId: PRODUCT, editionId: "standard", releaseId: null, period: { anchor: "fixed", startsAt: h.clock.now() - 1000, endsAt: h.clock.now() + 86_400_000 }, authorisedBy: "founder (test)", performedBy: "operator (test)" }, h.clock.now());
    const link = await anyone.call("POST", `/api/v1/publishing/artifacts/${up.id}/download-url`);
    expect(link.status).toBe(200); // free + public during a window: any signed-in HCG account
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
      d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: name, platform: "ios", format: "deb", sizeBytes: file.length, sha256: sha(file), architectures: ["iphoneos-arm64"], package: pkg, ...PROV });
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
    expect(h.app.publishing.publishedFor("fixture-quasar-shell", "unleashed")).toEqual([]); // approved, not yet published
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "1.0.1" })).status).toBe(200);
    // …and only then, as a normal entitlement-gated Store artifact with its version and layout for Sileo.
    expect(h.app.publishing.publishedFor("fixture-quasar-shell", "unleashed").map((a) => a.id)).toEqual([ok.body.artifact.id]);
    expect(h.app.publishing.publishedMeta(ok.body.artifact.id)).toEqual({ version: "1.0.1", architectures: ["iphoneos-arm64"] });
  });
  it("HCG Repo companion changes: Debian version = release version, free public releases for any signed-in account, and a release listing", async () => {
    const d = await desktop();
    const make = async (version: string, distribution: string, build: string) => {
      const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, editionId: "unleashed", version, build, distribution, compatibility: { minimumOs: {}, architectures: ["iphoneos-arm64"], notes: [] }, destinations: ["hcg-store", "hcg-repo"] });
      expect(rel.status, JSON.stringify(rel.body)).toBe(201);
      return rel.body.id as string;
    };
    const ship = async (releaseId: string, file: Buffer, pkg: { id: string; version: string; architecture: string }) => {
      const a = await d.call("POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { fileName: `q_${pkg.version}.deb`, platform: "ios", format: "deb", sizeBytes: file.length, sha256: sha(file), architectures: ["iphoneos-arm64"], package: pkg, ...PROV });
      if (a.status !== 201) return a;
      expect((await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(200);
      return d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`);
    };
    const PKG = "com.example.fixture.quasar.unleashed";
    // 1. A control file numbered 2.0.0 inside release 2.0.1 could never be matched by Sileo: refused, declared or hidden.
    const r1 = await make("2.0.1", "free", "201");
    expect((await ship(r1, deb(PKG, "2.0.0", "iphoneos-arm64"), { id: PKG, version: "2.0.0", architecture: "iphoneos-arm64" })).body.error.message).toContain("Debian version is 2.0.0");
    const hidden = await ship(r1, deb(PKG, "2.0.0", "iphoneos-arm64"), { id: PKG, version: "2.0.1", architecture: "iphoneos-arm64" });
    expect(hidden.status).toBe(422);
    const ok = await ship(r1, deb(PKG, "2.0.1-1", "iphoneos-arm64"), { id: PKG, version: "2.0.1-1", architecture: "iphoneos-arm64" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const fileId = ok.body.artifact.id as string;
    await d.call("POST", `/api/v1/publishing/releases/${r1}/submit`);

    // Before public approval nothing is listed for HCG Repo and nothing is free.
    expect((await d.call("GET", "/api/v1/repo/releases?destination=hcg-repo")).body.releases).toEqual([]);
    const stranger = await h.signIn(STRANGER);
    expect((await stranger.get(`/api/v1/downloads/${fileId}`)).status).toBe(404); // not published: not revealed
    const approverWeb = await h.signIn(APPROVER);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${r1}/approve`, { eligibility: "public", confirm: "2.0.1" })).status).toBe(200);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${r1}/publish`, { confirm: "2.0.1" })).status).toBe(200);

    // 2. Public + free: any signed-in account, without owning it, while a free testing window is open; signed out still 401.
    openWindow(h.db, { productId: "fixture-quasar-shell", editionId: "unleashed", releaseId: null, period: { anchor: "fixed", startsAt: h.clock.now() - 1000, endsAt: h.clock.now() + 86_400_000 }, authorisedBy: "founder (test)", performedBy: "operator (test)" }, h.clock.now());
    const access = (await (await stranger.get("/api/v1/products/fixture-quasar-shell/access")).json()) as { editions: { editionId: string; state: string; owned: boolean; artifacts: { id: string }[] }[] };
    const unleashed = access.editions.find((e) => e.editionId === "unleashed")!;
    expect([unleashed.state, unleashed.owned, unleashed.artifacts.map((x) => x.id)]).toEqual(["free", false, [fileId]]);
    const got = await stranger.get(`/api/v1/downloads/${fileId}`);
    expect(got.status).toBe(200);
    expect(sha(Buffer.from(await got.arrayBuffer()))).toBe(ok.body.artifact.sha256);
    expect((await fetch(`${h.origin}/api/v1/downloads/${fileId}`)).status).toBe(401);
    // The standard edition (paid, nothing free) stays not owned.
    expect(access.editions.find((e) => e.editionId === "standard")!.state).not.toBe("free");

    // 3. The listing: metadata of approved and withdrawn packages, for people HCG lets publish or approve the product.
    const listed = (await d.call("GET", "/api/v1/repo/releases?destination=hcg-repo")).body;
    expect(listed.releases).toHaveLength(1);
    expect(listed.releases[0]).toMatchObject({ id: r1, version: "2.0.1", status: "approved", distribution: "free", withdrawnAt: null });
    expect(listed.releases[0].artifacts).toEqual([{ id: fileId, fileName: "q_2.0.1-1.deb", sha256: ok.body.artifact.sha256, sizeBytes: expect.any(Number), architectures: ["iphoneos-arm64"], package: { id: PKG, version: "2.0.1-1", architecture: "iphoneos-arm64", source: "control-file" }, kind: "jailbreak-package" }]);
    expect(JSON.stringify(listed)).not.toMatch(/url|storage/i);
    expect((await (await desktop(STRANGER)).call("GET", "/api/v1/repo/releases?destination=hcg-repo")).body.releases).toEqual([]);
    expect((await d.call("GET", "/api/v1/repo/releases")).status).toBe(400);
    expect((await fetch(`${h.origin}/api/v1/repo/releases?destination=hcg-repo`)).status).toBe(401);

    // Withdrawal reaches HCG Repo through the listing, and free access ends at once.
    expect((await approverWeb.post(`/api/v1/publishing/releases/${r1}/withdraw`, { reason: "Test withdrawal" })).status).toBe(200);
    expect((await d.call("GET", "/api/v1/repo/releases?destination=hcg-repo")).body.releases[0]).toMatchObject({ status: "withdrawn", withdrawnReason: "Test withdrawal", withdrawnAt: expect.any(Number) });
    expect((await stranger.get(`/api/v1/downloads/${fileId}`)).status).toBe(404);
  });

  it("generates catalogue/releases.json from manual approvals: no second review, explicit current release, withdrawal, tamper refusal", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version: "3.0.0", build: "300", channel: "stable" });
    const file = ipa([]);
    const f = await upload(d, rel.body.id, file, "Sample-3.0.0.ipa");
    expect((await f.complete()).status).toBe(200);
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const approverWeb = await h.signIn(APPROVER);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "internal-testing", confirm: "3.0.0", current: true })).status).toBe(400);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "3.0.0", current: true })).status).toBe(200);
    // Approved but unpublished: not exported to the public catalogue.
    expect(exportReleaseRecords(h.db, Date.now()).records).toHaveLength(0);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "3.0.0" })).status).toBe(200);

    const docs = JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "products.json"), "utf8"));
    const products = docs.products.map((p: any) => ({ id: p.id, centralId: p.registry.centralId, editionIds: (p.editions ?? []).map((e: any) => e.id), currentReleaseId: p.currentReleaseId ?? null }));
    const manual = JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "releases.json"), "utf8")).releases;
    const exported = exportReleaseRecords(h.db, Date.now());
    expect(exported.auditIntact).toBe(true);
    expect(JSON.stringify(exported)).not.toMatch(/user-|storage|https?:/); // no account IDs, file locations or URLs
    const out = syncReleases(manual, products, exported);
    const generated = out.releases.filter((r) => r.source?.kind === "hcg-store-approval");
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ id: rel.body.id, productId: PRODUCT, version: "3.0.0", build: "300", channel: "stable", status: "approved",
      artifacts: [{ id: f.id, fileName: "Sample-3.0.0.ipa", format: "ipa", platform: "ios", sha256: sha(file), editionId: "standard", signing: { status: "signed", evidence: expect.stringContaining("not verified by HCG Store") } }] });
    expect(out.releases.filter((r) => !r.source)).toEqual(manual); // hand-written entries untouched
    expect(out.currentReleaseIds).toEqual({ [PRODUCT]: rel.body.id }); // the approver's explicit choice
    const nextProducts = { ...docs, products: docs.products.map((p: any) => (p.id in out.currentReleaseIds ? { ...p, currentReleaseId: out.currentReleaseIds[p.id] } : p)) };
    expect(validateCatalogue(nextProducts, { schemaVersion: 1, releases: out.releases }).ok).toBe(true);

    // Withdrawal: the entry stays as history, is no longer offered, and stops being current.
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/withdraw`, { reason: "Crash on start." })).status).toBe(200);
    const after = syncReleases(out.releases, products.map((p: any) => ({ ...p, currentReleaseId: out.currentReleaseIds[p.id] ?? p.currentReleaseId })), exportReleaseRecords(h.db, Date.now()));
    expect(after.releases.find((r) => r.id === rel.body.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "Crash on start.", artifacts: [] });
    expect(after.currentReleaseIds).toEqual({ [PRODUCT]: null });

    // A private or internal-testing approval is never exported; an altered audit refuses the whole export.
    h.db.exec("DROP TRIGGER pub_audit_no_update");
    h.db.prepare("UPDATE pub_audit SET detail = ? WHERE action = 'release.approved'").run(JSON.stringify({ eligibility: "public", current: false }));
    expect(() => syncReleases(manual, products, exportReleaseRecords(h.db, Date.now()))).toThrow(/audit chain/);
  });

  // ───────────── Ship to Shop: what each file is, and who may see a draft ─────────────

  async function send(d: Desktop, releaseId: string, file: Buffer, decl: Record<string, unknown>) {
    const a = await d.call("POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { sizeBytes: file.length, sha256: sha(file), signing: { status: "not-checked", evidence: null, tool: null }, ...decl, ...PROV });
    if (a.status !== 201) return a;
    expect((await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(200);
    return d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`);
  }

  it("decides each file's kind from its content and never calls an unsigned, Simulator or jailbreak file ready for ordinary installation", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version: "2.0.0", build: "1" });
    expect(rel.status).toBe(201);
    const ios = (name: string) => ({ fileName: name, platform: "ios", format: "ipa" });
    // Simulator builds: refused when declared as such, and found in the content when not.
    const declaredSim = await send(d, rel.body.id, ipa([], { simulator: true }), { ...ios("Sim.ipa"), kind: "simulator-build" });
    expect([declaredSim.status, declaredSim.body.error.message]).toEqual([400, expect.stringContaining("Simulator builds")]);
    const hiddenSim = await send(d, rel.body.id, ipa([], { simulator: true }), ios("Sim2.ipa"));
    expect(hiddenSim.status).toBe(422);
    expect(hiddenSim.body.message).toContain("iOS Simulator build");
    expect(hiddenSim.body.artifact.kind).toBe("simulator-build");
    // A declaration that contradicts the format is refused.
    expect((await send(d, rel.body.id, ipa(), { ...ios("Wrong.ipa"), kind: "installer" })).status).toBe(400);
    // Device builds: signing decides what the label says.
    const cases: [string, Buffer, string][] = [
      ["Unsigned.ipa", ipa([], { signed: false }), "unsigned"],
      ["NoProfile.ipa", ipa([], { profile: null }), "not-installable"],
      ["Dev.ipa", ipa([], { profile: "development" }), "registered-devices-only"],
      ["AdHoc.ipa", ipa([], { profile: "ad-hoc" }), "registered-devices-only"],
      ["Enterprise.ipa", ipa([], { profile: "enterprise" }), "enterprise-devices-only"],
      ["AppStore.ipa", ipa([], { profile: "app-store" }), "app-store-profile"],
    ];
    for (const [name, file, status] of cases) {
      const r = await send(d, rel.body.id, file, { ...ios(name), kind: "device-build", signing: { status: "signed", evidence: "uploader says signed", tool: "x" } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect([name, r.body.artifact.kind, r.body.artifact.kindCheckedByStore, r.body.artifact.readiness.status, r.body.artifact.readiness.ordinaryInstall]).toEqual([name, "device-build", true, status, false]);
    }
    // Jailbreak packages are iOS packages, never Linux ones; a Linux .deb is an installer that needs no platform signature.
    const jbOnLinux = await send(d, rel.body.id, deb("com.example.tweak", "2.0.0", "iphoneos-arm64"), { fileName: "tweak.deb", platform: "linux", format: "deb" });
    expect([jbOnLinux.status, jbOnLinux.body.message]).toEqual([422, expect.stringContaining("jailbreak package for iOS")]);
    const jb = await send(d, rel.body.id, deb("com.example.tweak", "2.0.0", "iphoneos-arm64"), { fileName: "tweak2.deb", platform: "ios", format: "deb", kind: "jailbreak-package", architectures: ["iphoneos-arm64"] });
    expect([jb.body.artifact.kind, jb.body.artifact.readiness.status, jb.body.artifact.readiness.ordinaryInstall]).toEqual(["jailbreak-package", "jailbroken-devices-only", false]);
    const linux = await send(d, rel.body.id, deb("com.example.tool", "2.0.0", "amd64"), { fileName: "tool.deb", platform: "linux", format: "deb", kind: "installer", architectures: ["amd64"] });
    expect([linux.body.artifact.kind, linux.body.artifact.readiness.status, linux.body.artifact.readiness.ordinaryInstall]).toEqual(["installer", "ready", true]);
    // The review page says what each file is and how it installs, and offers the authorised review download.
    const approverWeb = await h.signIn(APPROVER);
    const page = await (await approverWeb.get(`/publishing/releases/${rel.body.id}`)).text();
    for (const text of ["iOS device build", "Unsigned iOS device build", "Jailbreak package: installs only on jailbroken", "Linux package", "Download to review"]) expect(page).toContain(text);
    // Public approval is refused while an unsigned device build is part of the release; internal testing is allowed.
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const pub = await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "2.0.0" });
    expect([pub.status, ((await pub.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_installable"]);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "internal-testing", confirm: "2.0.0" })).status).toBe(200);
  });

  it("lets HCG's approvers download a draft to review it, refuses everyone else, and never makes an upload public", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version: "2.1.0", build: "1", eligibility: "public" });
    const file = ipa([{ name: "Payload/Sample.app/Sample", data: randomBytes(300_000) }]);
    const a = await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "Review.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file), kind: "device-build", ...PROV });
    // Unauthorised uploads: another HCG account cannot add files, a forged upload URL is refused.
    const buyer = await desktop(BUYER);
    expect((await buyer.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "Evil.ipa", platform: "ios", format: "ipa", sizeBytes: 10, sha256: sha(Buffer.from("x")) })).status).toBe(403);
    const forged = a.body.uploadUrl.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    expect((await fetch(forged, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(403);
    expect((await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(200);
    expect((await d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`)).status).toBe(200);
    // Draft review: the approver downloads exactly the uploaded bytes in the browser; buyers cannot; nothing is public.
    const approverWeb = await h.signIn(APPROVER);
    const review = await fetchDownload(approverWeb, a.body.artifact.id);
    expect(review.status).toBe(200);
    expect(sha((review as { bytes: Buffer }).bytes)).toBe(sha(file));
    expect((await fetchDownload(buyer, a.body.artifact.id)).status).toBe(403);
    expect((await fetchDownload(await h.signIn(BUYER), a.body.artifact.id)).status).toBe(403);
    expect(h.app.publishing.publishedFor(PRODUCT, "standard").map((x) => x.id)).not.toContain(a.body.artifact.id);
    const log = (await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`)).body.audit as { action: string; detail: { basis?: string } }[];
    expect(log.filter((x) => x.action === "artifact.downloaded").map((x) => x.detail.basis)).toEqual(["approver-review"]);
  });

  it("keeps one release per version and build for products without editions, and a retry returns the same draft", async () => {
    const d = await desktop();
    expect((await d.call("POST", "/api/v1/publishing/products", { id: "editionless-tool", title: "Editionless Tool" })).status).toBe(201);
    const body = { ...RELEASE, productId: "editionless-tool", editionId: null, version: "0.1.0", build: "1", eligibility: "private" };
    const first = await d.call("POST", "/api/v1/publishing/releases", body);
    const retry = await d.call("POST", "/api/v1/publishing/releases", body);
    expect([first.status, retry.status, retry.body.id]).toEqual([201, 200, first.body.id]);
    await send(d, first.body.id, ipa(), { fileName: "T.ipa", platform: "ios", format: "ipa" });
    await d.call("POST", `/api/v1/publishing/releases/${first.body.id}/submit`);
    const after = await d.call("POST", "/api/v1/publishing/releases", body);
    expect([after.status, after.body.error.code]).toEqual([409, "version_exists"]);
  });

  // ───────────── Distribution Infrastructure v2: Android formats, provenance, Release Manager ─────────────

  const apk = (opts: { v1?: boolean; v2?: boolean; dex?: boolean } = {}) =>
    zip([{ name: "AndroidManifest.xml" }, ...(opts.dex === false ? [] : [{ name: "classes.dex" }]), { name: "resources.arsc" }, ...(opts.v1 ? [{ name: "META-INF/CERT.RSA" }, { name: "META-INF/CERT.SF" }] : [])],
      opts.v2 ? Buffer.concat([randomBytes(24), Buffer.from("APK Sig Block 42")]) : undefined);
  const aab = () => zip([{ name: "BundleConfig.pb" }, { name: "base/manifest/AndroidManifest.xml" }, { name: "base/dex/classes.dex" }]);

  it("accepts Android APKs and App Bundles by content; an App Bundle is never delivered to customers", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, editionId: "standard", version: "5.0.0", build: "500", compatibility: { minimumOs: {}, architectures: [], notes: [] } });
    const android = (fileName: string, format: string) => ({ fileName, platform: "android", format });
    // Content decides: an APK without classes.dex, or an AAB without its manifest, is refused.
    expect((await send(d, rel.body.id, apk({ dex: false, v2: true }), android("NoDex.apk", "apk"))).status).toBe(422);
    expect((await send(d, rel.body.id, apk({ v2: true }), android("Wrong.aab", "aab"))).status).toBe(422);
    const signed = await send(d, rel.body.id, apk({ v2: true }), android("App-5.0.0.apk", "apk"));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.artifact).toMatchObject({ kind: "android-app", validation: { signatureStructure: "present" }, readiness: { ordinaryInstall: false }, customerDelivery: true });
    expect((await send(d, rel.body.id, apk({ v1: true }), android("V1-5.0.0.apk", "apk"))).body.artifact.validation.signatureStructure).toBe("present");
    expect((await send(d, rel.body.id, apk(), android("Unsigned-5.0.0.apk", "apk"))).body.artifact.readiness.status).toBe("unsigned");
    const bundle = await send(d, rel.body.id, aab(), android("App-5.0.0.aab", "aab"));
    expect(bundle.body.artifact).toMatchObject({ kind: "distribution-bundle", readiness: { status: "distribution-only", ordinaryInstall: false }, customerDelivery: false });
    // An unsigned APK blocks public approval, like an unsigned iOS build.
    const unsignedId = (await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`)).body.artifacts.find((a: any) => a.fileName === "Unsigned-5.0.0.apk").id;
    await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    const approverWeb = await h.signIn(APPROVER);
    const refused = await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "5.0.0" });
    expect(refused.status).toBe(409);
    // Removing that file takes the release back to draft; then submit, approve and publish.
    expect((await d.call("DELETE", `/api/v1/publishing/artifacts/${unsignedId}`)).status).toBe(200);
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`)).status).toBe(200);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: "5.0.0" })).status).toBe(200);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: "5.0.0" })).status).toBe(200);
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const buyer = await desktop(BUYER);
    expect((await fetchDownload(buyer, signed.body.artifact.id)).status).toBe(200);
    const denied = await fetchDownload(buyer, bundle.body.artifact.id);
    expect([denied.status, (denied.body as { error?: { code?: string } } | undefined)?.error?.code]).toEqual([403, "staff_only"]);
    expect(h.app.publishing.publishedFor(PRODUCT, "standard").map((x) => x.id)).not.toContain(bundle.body.artifact.id);
    expect((await fetchDownload(approverWeb, bundle.body.artifact.id)).status).toBe(200); // staff can still review it
    // The public catalogue never lists the App Bundle.
    const exported = exportReleaseRecords(h.db, Date.now());
    expect(exported.records[0]!.artifacts.map((a) => a.format).sort()).toEqual(["apk", "apk"]);
  });

  it("requires release notes and each file's source commit, build provider and toolchain at submission, never the repository", async () => {
    const d = await desktop();
    const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version: "6.0.0", build: "600", releaseNotes: [] });
    const file = ipa();
    const a = await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "Old.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file) });
    expect(a.status).toBe(201); // drafts stay compatible with older Executable Maker versions
    await fetch(a.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
    expect((await d.call("POST", `/api/v1/publishing/artifacts/${a.body.artifact.id}/complete`)).status).toBe(200);
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`)).body.error.code).toBe("release_notes_required");
    // Release notes are part of the draft; a new draft with notes, still without provenance:
    const rel2 = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version: "6.0.0", build: "601" });
    const b = await d.call("POST", `/api/v1/publishing/releases/${rel2.body.id}/artifacts`, { fileName: "Old.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file) });
    await fetch(b.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
    await d.call("POST", `/api/v1/publishing/artifacts/${b.body.artifact.id}/complete`);
    const missing = await d.call("POST", `/api/v1/publishing/releases/${rel2.body.id}/submit`);
    expect([missing.status, missing.body.error.code]).toEqual([409, "provenance_required"]);
    // Bad provenance is refused at declaration.
    for (const bad of [{ sourceCommit: "main" }, { buildProvider: "someone-elses-ci" }, { sourceRepository: "private/repo" }]) {
      expect((await d.call("POST", `/api/v1/publishing/releases/${rel2.body.id}/artifacts`, { fileName: "New.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file), ...PROV, ...bad })).status).toBe(400);
    }
    // A replacement with provenance (new file name) takes the old file out of the release; then it can be submitted.
    const c = await d.call("POST", `/api/v1/publishing/releases/${rel2.body.id}/artifacts`, { fileName: "New.ipa", platform: "ios", format: "ipa", sizeBytes: file.length, sha256: sha(file), ...PROV, validationReport: { tool: "HCG Executable Maker", passed: true, summary: "Bundle checks passed." }, replaces: b.body.artifact.id });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await fetch(c.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
    expect((await d.call("POST", `/api/v1/publishing/artifacts/${c.body.artifact.id}/complete`)).body.artifact.provenance).toEqual({ ...PROV, validationReport: { tool: "HCG Executable Maker", passed: true, summary: "Bundle checks passed." } });
    expect((await d.call("POST", `/api/v1/publishing/releases/${rel2.body.id}/submit`)).status).toBe(200);
    const view = (await d.call("GET", `/api/v1/publishing/releases/${rel2.body.id}`)).body;
    expect(view.artifacts.map((x: any) => [x.fileName, x.status]).sort()).toEqual([["New.ipa", "verified"], ["Old.ipa", "removed"]]);
    expect(view.stage).toBe("awaiting-approval");
  });

  it("Release Manager: a new file invalidates an approval; publication is explicit and may supersede; checksums, comparison and the cross-product list", async () => {
    const d = await desktop();
    const approverWeb = await h.signIn(APPROVER);
    const shipRelease = async (version: string, build: string, file: Buffer) => {
      const rel = await d.call("POST", "/api/v1/publishing/releases", { ...RELEASE, version, build, releaseNotes: [`Notes for ${version}.`] });
      expect(rel.body.stage).toBe("draft");
      const up = await upload(d, rel.body.id, file, `Sample-${version}.ipa`);
      expect((await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`)).body.stage).toBe("validation-pending");
      await up.complete();
      expect((await d.call("GET", `/api/v1/publishing/releases/${rel.body.id}`)).body.stage).toBe("uploaded");
      await d.call("POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
      expect((await approverWeb.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "public", confirm: version })).status).toBe(200);
      return { id: rel.body.id as string, fileId: up.id };
    };
    const v1 = await shipRelease("7.0.0", "700", ipa());
    // Adding a file after approval: the approval no longer applies, the release is a draft again, and it says why.
    const extra = await upload(d, v1.id, ipa([{ name: "Payload/Sample.app/extra.txt" }]), "Sample-7.0.0-b.ipa");
    let view = (await d.call("GET", `/api/v1/publishing/releases/${v1.id}`)).body;
    expect([view.status, view.approvedEligibility, view.approvedBy]).toEqual(["draft", null, null]);
    expect(view.audit.map((x: any) => x.action)).toContain("release.approval-invalidated");
    expect((await approverWeb.post(`/api/v1/publishing/releases/${v1.id}/publish`, { confirm: "7.0.0" })).status).toBe(409); // not approved any more
    await extra.complete();
    await d.call("POST", `/api/v1/publishing/releases/${v1.id}/submit`);
    expect((await approverWeb.post(`/api/v1/publishing/releases/${v1.id}/approve`, { eligibility: "public", confirm: "7.0.0" })).status).toBe(200);
    // The creator can never publish; the approver publishes.
    const creatorWeb = await h.signIn(PUBLISHER);
    ledger.grant(PUBLISHER.sub, "*", featureEdition("store.release.approve"), "test", null);
    expect((await creatorWeb.post(`/api/v1/publishing/releases/${v1.id}/publish`, { confirm: "7.0.0" })).status).toBe(403);
    expect(((await (await approverWeb.post(`/api/v1/publishing/releases/${v1.id}/publish`, { confirm: "7.0.0" })).json()) as { stage: string }).stage).toBe("published");
    // Published files are immutable: no new files, no removals.
    expect((await d.call("POST", `/api/v1/publishing/releases/${v1.id}/artifacts`, { fileName: "Late.ipa", platform: "ios", format: "ipa", sizeBytes: 10, sha256: "a".repeat(64), ...PROV })).status).toBe(409);
    expect((await d.call("DELETE", `/api/v1/publishing/artifacts/${v1.fileId}`)).status).toBe(409);

    // A second release, published WITHOUT superseding, leaves the first published; with supersede it replaces it.
    const v2 = await shipRelease("7.1.0", "710", ipa([{ name: "Payload/Sample.app/new.txt" }]));
    expect((await approverWeb.post(`/api/v1/publishing/releases/${v2.id}/publish`, { confirm: "7.1.0", supersede: true })).status).toBe(200);
    expect((await d.call("GET", `/api/v1/publishing/releases/${v1.id}`)).body).toMatchObject({ status: "superseded", supersededBy: v2.id });
    ledger.grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const buyer = await desktop(BUYER);
    expect((await fetchDownload(buyer, v1.fileId)).status).toBe(410);
    expect((await fetchDownload(buyer, v2.fileId)).status).toBe(200);

    // Checksum re-verification of the stored files; a changed file on disk is caught.
    const ok = await d.call("POST", `/api/v1/publishing/releases/${v2.id}/verify-checksums`);
    expect([ok.status, ok.body.ok, ok.body.files.length]).toEqual([200, true, 1]);
    const key = (h.db.prepare("SELECT storage_key FROM pub_artifacts WHERE id = ?").get(v2.fileId) as { storage_key: string }).storage_key;
    const { chmodSync, writeFileSync } = await import("node:fs");
    const path = join(h.cfg.artifactStorageDir, key);
    chmodSync(path, 0o644);
    writeFileSync(path, "tampered");
    const bad = await d.call("POST", `/api/v1/publishing/releases/${v2.id}/verify-checksums`);
    expect([bad.status, bad.body.ok]).toEqual([409, false]);

    // Comparison between versions of one product.
    const cmp = (await d.call("GET", `/api/v1/publishing/compare?from=${v1.id}&to=${v2.id}`)).body;
    expect(cmp.fields.map((f: any) => f.field)).toEqual(expect.arrayContaining(["version", "build", "status"]));
    expect(cmp.releaseNotes).toEqual({ added: ["Notes for 7.1.0."], removed: ["Notes for 7.0.0."] });
    expect(cmp.files.some((f: any) => f.change === "changed")).toBe(true);

    // Cross-product list for the people HCG lets publish or approve; nobody else sees anything.
    const list = (await approverWeb.get("/api/v1/publishing/manager").then((r) => r.json())) as { releases: { id: string; stage: string }[]; auditIntact: boolean };
    expect(list.releases.map((r) => [r.id, r.stage])).toEqual([[v2.id, "published"], [v1.id, "superseded"]]);
    expect(list.auditIntact).toBe(true);
    expect((await (await h.signIn(STRANGER)).get("/api/v1/publishing/manager").then((r) => r.json()) as { releases: unknown[] }).releases).toEqual([]);
  });
});
