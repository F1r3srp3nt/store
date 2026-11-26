// @vitest-environment node
/**
 * Ship to Store modes and diagnostics (HCG_STORE_PUBLISHING = disabled | submissions | enabled), against the real server
 * code with the mock HCG Connect provider and the TEST entitlement ledger standing in for HCG's central authority.
 *
 * "submissions" is what HCG Executable Maker needs while public publication stays off: an authorised person submits a
 * private draft, uploads files (resumable, checked by SHA-256 on the server), attaches Release Passports and submits the
 * release for review. Nothing is delivered and nothing becomes public.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { parseStoreConfig, ConfigError } from "../src/config";
import { startHarness, type Harness } from "./harness";

const MAKER_CLIENT = "99999999-8888-4777-8666-555555555555";
const STORE_MANAGER_CLIENT = "77777777-6666-4555-8444-333333333333";
const PUBLISHER = { sub: "user-publisher", email: "pub@example.test", name: "Publisher" };
const APPROVER = { sub: "user-approver", email: "approver@example.test", name: "Approver" };
const STRANGER = { sub: "user-stranger", email: "x@example.test", name: "Stranger", role: "admin" };
const PRODUCT = "fixture-quasar-shell";
const sha = (b: Buffer, algo = "sha256") => createHash(algo).update(b).digest("hex");

/** A minimal Windows PE file (MZ header pointing at a PE signature), padded so it spans several upload chunks. */
function pe(tag: string, size = 2_600_000): Buffer {
  const b = Buffer.alloc(size);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(0x8664, 0x84);
  b.write(tag, 0x200, "latin1");
  return b;
}

let h: Harness | undefined;
async function start(mode: "disabled" | "submissions" | "enabled", extra: Record<string, string> = {}) {
  h = await startHarness({
    env: {
      HCG_STORE_PUBLISHING: mode,
      HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER_CLIENT,
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      ...(mode === "enabled" ? { HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish" } : {}),
      HCG_STORE_UPLOAD_CHUNK_MB: "1",
      ...extra,
    },
  });
  h.idp.otherClients.add(MAKER_CLIENT);
  h.idp.otherClients.add(STORE_MANAGER_CLIENT);
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
const maker = (user = PUBLISHER, client = MAKER_CLIENT) => h!.idp.accessToken(user, client);
const RELEASE = { productId: PRODUCT, editionId: "standard", version: "2.0.0-beta.1", build: "7", releaseNotes: ["Private test build."], distribution: "paid", eligibility: "private" };
const PROV = { sourceCommit: "0123abcd", buildProvider: "local", toolchain: ".NET SDK 10.0 (test)" };

describe("Ship to Store status (diagnostics)", () => {
  it("answers when Ship to Store is switched off, stage by stage, without sign-in; every other route says why it is off", async () => {
    await start("disabled");
    const s = await call(null, "GET", "/api/v1/publishing/status");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ apiVersion: 1, minimumClientApiVersion: 1, publishing: "disabled", server: { mode: "test" }, hcgConnect: { configured: true }, caller: null, limits: null });
    for (const stage of ["draftCreation", "artifactUpload", "passportAttachment", "releaseSubmission", "approval", "publicPublication"]) {
      expect(s.body.stages[stage].available, stage).toBe(false);
      expect(s.body.stages[stage].reason).toMatch(/HCG_STORE_PUBLISHING=disabled/);
    }
    const r = await call(await maker(), "GET", "/api/v1/publishing/products");
    expect(r).toMatchObject({ status: 404, body: { error: { code: "publishing_disabled" } } });
    expect(r.body.error.message).toMatch(/HCG_STORE_PUBLISHING=submissions/);
  });

  it("separates token validity, client registration and each HCG permission, and never echoes the token", async () => {
    await start("submissions");
    const token = await maker();
    const ok = await call(token, "GET", "/api/v1/publishing/status");
    expect(ok.body.caller).toMatchObject({ token: "valid", sub: PUBLISHER.sub, email: PUBLISHER.email, clientId: MAKER_CLIENT, clientRegistered: true, clientReason: null,
      permissions: { submit: "granted", approve: "not-granted", publish: "switched-off" }, authorizedProducts: expect.any(Number) });
    expect(ok.body.caller.authorizedProducts).toBeGreaterThan(0);
    expect(ok.body.caller.scopes).toContain("openid");
    expect(JSON.stringify(ok.body)).not.toContain(token);

    // Another app's client (e.g. HCG Store Manager) is a valid sign-in, but not registered for Maker's publishing.
    const other = await call(await maker(PUBLISHER, STORE_MANAGER_CLIENT), "GET", "/api/v1/publishing/status");
    expect(other.body.caller).toMatchObject({ token: "valid", clientId: STORE_MANAGER_CLIENT, clientRegistered: false, authorizedProducts: null });
    expect(other.body.caller.clientReason).toMatch(/not registered for publishing/);
    // The Store's own web client never publishes.
    const web = await call(await maker(PUBLISHER, h!.idp.clientId), "GET", "/api/v1/publishing/status");
    expect(web.body.caller.clientReason).toMatch(/HCG Store's own web sign-in/);

    // A tampered signature and an expired token are told apart.
    const at = token.lastIndexOf(".") + 5;
    const forged = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect((await call(forged, "GET", "/api/v1/publishing/status")).body.caller).toMatchObject({ token: "invalid" });
    h!.clock.advance(h!.idp.accessTtlSeconds + 120);
    expect((await call(token, "GET", "/api/v1/publishing/status")).body.caller).toMatchObject({ token: "expired", reason: "The access token has expired." });

    // An account without HCG's permission is told so, with the client still registered.
    const stranger = await call(await maker(STRANGER), "GET", "/api/v1/publishing/status");
    expect(stranger.body.caller).toMatchObject({ clientRegistered: true, permissions: { submit: "not-granted" }, authorizedProducts: null });
  });
});

describe("Private submissions while public publication is switched off", () => {
  it("draft → resumable upload → server SHA-256 → passport → submit → Release Manager; publication and delivery stay off", async () => {
    await start("submissions");
    const s = (await call(null, "GET", "/api/v1/publishing/status")).body;
    expect(s.publishing).toBe("submissions");
    expect(s.stages).toMatchObject({ draftCreation: { available: true }, artifactUpload: { available: true }, passportAttachment: { available: true }, releaseSubmission: { available: true }, approval: { available: true, where: "browser" }, publicPublication: { available: false, where: "browser" } });
    expect(s.stages.publicPublication.reason).toMatch(/HCG_STORE_PUBLISHING=submissions/);

    const token = await maker();
    const products = (await call(token, "GET", "/api/v1/publishing/products")).body.products as { id: string; editions: { id: string }[] }[];
    expect(products.find((p) => p.id === PRODUCT)?.editions.map((e) => e.id)).toContain("standard");

    // Private draft.
    const rel = await call(token, "POST", "/api/v1/publishing/releases", RELEASE);
    expect(rel.status, JSON.stringify(rel.body)).toBe(201);
    expect(rel.body).toMatchObject({ status: "draft", requestedEligibility: "private" });

    // Declare a genuine-shaped Windows executable; upload half, "lose the connection", resume from what the Store has.
    const file = pe("HCG test app");
    const declared = await call(token, "POST", `/api/v1/publishing/releases/${rel.body.id}/artifacts`, { fileName: "QuasarShell-2.0.0-beta.1-win-x64.exe", platform: "windows", format: "exe", sizeBytes: file.length, sha256: sha(file), architectures: ["x64"], signing: { status: "unsigned", evidence: "No Authenticode signature (HCG Executable Maker).", tool: "HCG Executable Maker" }, ...PROV });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    const chunk = declared.body.chunkBytes as number;
    const put = (start: number) => fetch(declared.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${start}-${Math.min(file.length, start + chunk) - 1}/${file.length}` }, body: file.subarray(start, Math.min(file.length, start + chunk)) });
    expect((await put(0)).status).toBe(200);
    const received = (await (await fetch(declared.body.uploadUrl)).json()) as { received: number };
    expect(received.received).toBe(chunk);
    for (let at = received.received; at < file.length; at += chunk) expect((await put(at)).status).toBe(200);
    const done = await call(token, "POST", `/api/v1/publishing/artifacts/${declared.body.artifact.id}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.artifact).toMatchObject({ status: "verified", sha256: sha(file), sizeBytes: file.length });

    // Release Passport describing exactly these bytes; a passport for other bytes is refused.
    const passport = { format: "hcg.release-passport", formatVersion: 1, source: { repository: "Example/Quasar", commit: "0123abcd" }, build: { provider: "local", run_id: null },
      artifact: { filename: "QuasarShell-2.0.0-beta.1-win-x64.exe", size: file.length, sha256: sha(file), sha512: sha(file, "sha512") } };
    const wrongPassport = await call(token, "POST", `/api/v1/publishing/artifacts/${declared.body.artifact.id}/passport`, { ...passport, artifact: { ...passport.artifact, sha512: "0".repeat(128) } });
    expect(wrongPassport).toMatchObject({ status: 422, body: { error: { code: "passport_mismatch" } } });
    expect((await call(token, "POST", `/api/v1/publishing/artifacts/${declared.body.artifact.id}/passport`, passport)).status).toBe(200);

    // Submit for review; the Release Manager lists it, waiting for approval.
    const submitted = await call(token, "POST", `/api/v1/publishing/releases/${rel.body.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.status).toBe("submitted");
    const manager = (await call(token, "GET", "/api/v1/publishing/manager")).body;
    expect(manager.releases.find((r: { id: string }) => r.id === rel.body.id)).toMatchObject({ status: "submitted", files: 1, mayPublication: false });
    expect(manager.auditIntact).toBe(true);

    // A person may approve in the browser; publication stays off and nothing is delivered.
    const approver = await h!.signIn(APPROVER);
    const approved = await approver.post(`/api/v1/publishing/releases/${rel.body.id}/approve`, { eligibility: "private", confirm: RELEASE.version });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const pub = await approver.post(`/api/v1/publishing/releases/${rel.body.id}/publish`, { confirm: RELEASE.version });
    expect(pub.status).toBe(409);
    expect(((await pub.json()) as { error: { code: string } }).error.code).toBe("publication_disabled");
    // The public release resolution never names the private release (only the catalogue's own entries).
    const resolution = await h!.anonymous().get(`/api/public/v1/release-resolution/${PRODUCT}`);
    expect(JSON.stringify(await resolution.json())).not.toContain(RELEASE.version);
  });

  it("delivers nothing to customers: an internal-testing approval does not open downloads, and HCG Repo gets no release to index", async () => {
    await start("submissions", { HCG_STORE_PROTECTED_DOWNLOADS: "enabled" });
    const BUYER = { sub: "user-buyer", email: "buyer@example.test", name: "Buyer" };
    (h!.authority as TestLedgerAuthority).grant(BUYER.sub, "fixture.quasar.shell", "standard", "test", null);
    const token = await maker();
    const rel = (await call(token, "POST", "/api/v1/publishing/releases", { ...RELEASE, eligibility: "internal-testing" })).body;
    const file = pe("internal", 4096);
    const d = await call(token, "POST", `/api/v1/publishing/releases/${rel.id}/artifacts`, { fileName: "Q.exe", platform: "windows", format: "exe", sizeBytes: file.length, sha256: sha(file), ...PROV });
    await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
    expect((await call(token, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`)).body.artifact.status).toBe("verified");
    expect((await call(token, "POST", `/api/v1/publishing/releases/${rel.id}/submit`)).status).toBe(200);
    const approver = await h!.signIn(APPROVER);
    expect((await approver.post(`/api/v1/publishing/releases/${rel.id}/approve`, { eligibility: "internal-testing", confirm: RELEASE.version })).status).toBe(200);
    // The entitled customer gets nothing; the person who submitted it can still download it to review.
    const buyer = await h!.signIn(BUYER);
    const refused = await buyer.post(`/api/v1/publishing/artifacts/${d.body.artifact.id}/download-url`);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("publication_disabled");
    expect((await call(token, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/download-url`)).status).toBe(200);
    expect((await call(token, "GET", "/api/v1/repo/releases?destination=hcg-repo")).body.releases).toEqual([]);
  });

  it("refuses unauthorised uploads: wrong client, no permission, a checksum that does not match", async () => {
    await start("submissions");
    const token = await maker();
    const rel = (await call(token, "POST", "/api/v1/publishing/releases", RELEASE)).body;
    const file = pe("x", 4096);
    const declare = (t: string, sum = sha(file)) => call(t, "POST", `/api/v1/publishing/releases/${rel.id}/artifacts`, { fileName: "Q.exe", platform: "windows", format: "exe", sizeBytes: file.length, sha256: sum, ...PROV });
    // HCG Store Manager's client identity is not Maker's: refused even for the same person.
    expect((await declare(await maker(PUBLISHER, STORE_MANAGER_CLIENT))).status).toBe(401);
    expect((await declare(await maker(STRANGER))).status).toBe(403);
    expect((await call(null, "POST", `/api/v1/publishing/releases/${rel.id}/artifacts`, {})).status).toBe(401);
    // Bytes that differ from the declared SHA-256 are never accepted.
    const d = await declare(token, "f".repeat(64));
    expect((await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file })).status).toBe(200);
    const c = await call(token, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`);
    expect(c.body.artifact.status).not.toBe("verified");
  });
});

describe("Publishing configuration", () => {
  const base = { HCG_STORE_MODE: "test" };
  it("accepts private submissions without a publication permission, and refuses full publishing without it", () => {
    const env = { HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER_CLIENT, HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish", HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve" };
    const problems = (extra: Record<string, string>) => { try { parseStoreConfig({ ...base, ...extra }); return []; } catch (e) { return e instanceof ConfigError ? e.problems : [String(e)]; } };
    expect(problems({ ...env, HCG_STORE_PUBLISHING: "submissions" }).filter((p) => /PUBLICATION_CENTRAL_ID/.test(p))).toEqual([]);
    expect(problems({ ...env, HCG_STORE_PUBLISHING: "enabled" }).some((p) => /PUBLICATION_CENTRAL_ID/.test(p))).toBe(true);
    expect(problems({ HCG_STORE_PUBLISHING: "public" }).some((p) => /"enabled", "submissions" or "disabled"/.test(p))).toBe(true);
  });
});
