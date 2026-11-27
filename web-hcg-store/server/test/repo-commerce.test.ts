// @vitest-environment node
/**
 * HCG Repo commercial package distribution, TEST environment only: the server-to-server entitlement contract
 * (`hcg.store.repo-entitlements/1`), purchases started in a package manager (Sileo and Zebra speak the same protocol;
 * both verified from their sources), purchase restoration, refunds, subscription expiry, revocation, temporary free
 * testing, and version and architecture eligibility. HCG's central decisions are stood in for by the TEST ledger;
 * payments by the TEST provider. Nothing here touches production.
 */
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { openWindow, terminateWindow } from "../src/free-windows";
import { signTestEvent } from "../src/payments";
import { signRepoRequest } from "../src/repo-s2s";
import { buy, startHarness, type Client, type Harness } from "./harness";

const ALICE = { sub: "user-alice", email: "alice@example.test", name: "Alice" };
const BOB = { sub: "user-bob", email: "bob@example.test", name: "Bob" };
const CAROL = { sub: "user-carol", email: "carol@example.test", name: "Carol" };
const PKG = "com.example.fixture.quasar.unleashed";
const OFFER = "fixture-quasar-unleashed-test";
const KEY_ID = "hcg-repo-test";
const SECRET = randomBytes(32);
const MAKER = "99999999-8888-4777-8666-555555555555";

let h: Harness | undefined;
async function start(env: Record<string, string> = {}) {
  h = await startHarness({ env: { HCG_STORE_REPO_S2S_KEY_ID: KEY_ID, HCG_STORE_REPO_S2S_SECRET: SECRET.toString("base64"), ...env } });
  return h;
}
afterEach(async () => { await h?.stop(); h = undefined; });
const ledger = () => h!.authority as TestLedgerAuthority;

/** HCG Repo's server calling HCG Store (HMAC-signed). */
async function s2s(method: "GET" | "POST", path: string, body?: unknown, opts: { secret?: Buffer; ts?: number; replay?: { sig: string; ts: number; nonce: string } } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = opts.replay?.ts ?? opts.ts ?? Math.floor(h!.clock.t / 1000);
  const nonce = opts.replay?.nonce ?? randomBytes(16).toString("base64url");
  const sig = opts.replay?.sig ?? signRepoRequest(opts.secret ?? SECRET, method, path, ts, nonce, raw);
  const r = await fetch(h!.origin + path, { method, headers: { "x-hcg-key-id": KEY_ID, "x-hcg-timestamp": String(ts), "x-hcg-nonce": nonce, "x-hcg-signature": sig, ...(raw ? { "content-type": "application/json" } : {}) }, body: raw || undefined });
  return { status: r.status, body: (await r.json()) as Record<string, any>, sig, ts, nonce };
}
const verify = (repoToken: string, extra: Record<string, unknown> = {}) => s2s("POST", "/api/s2s/v1/repo/entitlements/verify", { repoToken, packageId: PKG, architecture: "iphoneos-arm64", ...extra });

/** Sileo or Zebra: the package-manager protocol (POST JSON, token in the body; udid/device sent and ignored). */
async function pm(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${h!.origin}/repo-api/v1/sileo/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ udid: "00008110-FIXTURE-UDID", device: "iPhone14,2", ...body }) });
  return (await r.json()) as Record<string, any>;
}
/** The package manager's web-authentication sign-in → sileo://authentication_success?token=…&payment_secret=… */
async function pmSignIn(user: typeof ALICE) {
  h!.idp.nextUser = user;
  const startR = await fetch(`${h!.origin}/repo-api/v1/sileo/authenticate?udid=00008110-FIXTURE-UDID&model=iPhone14,2`, { redirect: "manual" });
  const authz = await fetch(startR.headers.get("location")!, { redirect: "manual" });
  const cb = await fetch(authz.headers.get("location")!, { redirect: "manual" });
  const loc = new URL(cb.headers.get("location")!);
  expect(loc.href.startsWith("sileo://authentication_success")).toBe(true);
  return { token: loc.searchParams.get("token")!, secret: loc.searchParams.get("payment_secret")! };
}

describe("server-to-server contract (hcg.store.repo-entitlements/1)", () => {
  it("is off unless configured, and accepts only correctly signed, fresh, never-replayed requests", async () => {
    h = await startHarness();
    expect((await fetch(`${h.origin}/api/s2s/v1/repo/packages`)).status).toBe(404); // not configured
    await h.stop();
    await start();
    expect((await fetch(`${h!.origin}/api/s2s/v1/repo/packages`)).status).toBe(401);
    expect((await s2s("GET", "/api/s2s/v1/repo/packages", undefined, { secret: randomBytes(32) })).status).toBe(401);
    expect((await s2s("GET", "/api/s2s/v1/repo/packages", undefined, { ts: Math.floor(h!.clock.t / 1000) - 600 })).status).toBe(401);
    const ok = await s2s("GET", "/api/s2s/v1/repo/packages");
    expect(ok.status).toBe(200);
    const replay = await s2s("GET", "/api/s2s/v1/repo/packages", undefined, { replay: { sig: ok.sig, ts: ok.ts, nonce: ok.nonce } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/replayed/);
  });

  it("lists the package mapping, pricing model and the current eligible versions with SHA-256, never a file URL", async () => {
    await start();
    const r = await s2s("GET", "/api/s2s/v1/repo/packages");
    expect(r.body.format).toBe("hcg.store.repo-entitlements/1");
    const p = (r.body.packages as Record<string, any>[]).find((x) => x.packageId === PKG)!;
    expect(p).toMatchObject({ productId: "fixture-quasar-shell", editionId: "unleashed", centralProductId: "fixture.quasar.shell", delivery: "commercial", paymentEndpoint: `${h!.origin}/repo-api/v1/sileo/` });
    expect(p.currentVersions).toEqual([{ version: "1.0.0", architectures: ["iphoneos-arm64"], fileName: `${PKG}_1.0.0_iphoneos-arm64.deb`, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), releaseId: "fixture-quasar-shell-1-0-0" }]);
    // The only URLs are the public product page and the payment endpoint: no file, no storage key, no account data.
    const urls = JSON.stringify(r.body).match(/https?:\/\/[^"]+/g) ?? [];
    expect(urls.every((u) => u.includes("/apps/") || u.endsWith("/repo-api/v1/sileo/"))).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/storageKey|storage_key|private|sub"/);
  });
});

describe("purchases from Sileo or Zebra, restoration, refunds, subscriptions, revocation", () => {
  it("purchase in the package manager → Store checkout (same account) → sileo://payment_completed; restore lists it", async () => {
    await start();
    const app = await pmSignIn(ALICE);
    // Not owned yet.
    expect(await pm(`package/${PKG}/info`, { token: app.token })).toMatchObject({ purchased: 0, available: 1 });
    expect((await verify(app.token)).body).toMatchObject({ decision: "deny", reason: "not_entitled", entitled: false });
    // Purchase: status 1 + an HTTPS URL on this Store, opened in the app's web-authentication session (callback scheme sileo).
    const p = await pm(`package/${PKG}/purchase`, { token: app.token, payment_secret: app.secret });
    expect(p.status).toBe(1);
    const url = new URL(p.url);
    expect(url.origin).toBe(h!.origin);
    expect(url.pathname).toMatch(/^\/repo-api\/v1\/sileo\/checkout\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // In the web-authentication session: no Store cookie yet → HCG Connect sign-in, back to the same purchase.
    const anon = await fetch(p.url, { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toMatch(/oauth\/authorize/);
    // Another HCG account in that window is refused.
    const bob = await h!.signIn(BOB);
    expect((await bob.get(url.pathname)).status).toBe(403);
    // The same account: the Store's own product page with the purchase context, then the normal checkout.
    const alice = await h!.signIn(ALICE);
    const toBuy = await alice.get(url.pathname);
    expect(toBuy.status).toBe(302);
    expect(toBuy.headers.get("location")).toBe(`/apps/fixture-quasar-shell?edition=unleashed&buy=1&pm=${url.pathname.split("/").pop()}`);
    // Returning before paying never says "completed".
    const early = await alice.get(`${url.pathname}/return`);
    expect(early.status).toBe(200);
    expect(await early.text()).toContain("Payment not completed yet");
    // The TEST provider's signed event grants the purchase (the redirect grants nothing); then the app is told.
    await buy(alice, OFFER, "pay");
    const done = await alice.get(`${url.pathname}/return`);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("sileo://payment_completed");
    // Restoration (user_info) and the app's package state.
    expect((await pm("user_info", { token: app.token })).items).toContain(PKG);
    expect(await pm(`package/${PKG}/info`, { token: app.token })).toMatchObject({ purchased: 1, price: "Owned" });
    expect(await pm(`package/${PKG}/purchase`, { token: app.token, payment_secret: app.secret })).toEqual({ status: 0 });
    // Server-to-server: allowed, on HCG's entitlement, for the current version and architecture only.
    const v = await verify(app.token, { version: "1.0.0-1" });
    expect(v.body).toMatchObject({ decision: "allow", reason: "entitled", basis: "entitlement", entitled: true, cacheSeconds: 60, delivery: { via: "hcg-store" } });
    expect((await verify(app.token, { version: "0.9.0" })).body).toMatchObject({ decision: "deny", reason: "version_not_eligible" });
    expect((await verify(app.token, { architecture: "iphoneos-arm" })).body).toMatchObject({ decision: "deny", reason: "architecture_not_available" });
    // Delivery stays with HCG Store: a short-lived signed URL, then the bytes.
    const auth = await pm(`package/${PKG}/authorize_download`, { token: app.token, version: "1.0.0", architecture: "iphoneos-arm64" });
    expect(auth.url).toMatch(/\/repo-api\/v1\/files\//);
    expect((await fetch(auth.url)).status).toBe(200);
    // Nothing from the device (UDID, model) is stored anywhere.
    const tables = (h!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) expect(JSON.stringify(h!.db.prepare(`SELECT * FROM "${t}"`).all())).not.toContain("FIXTURE-UDID");
  });

  it("a refund revokes on the next request: verification denies, delivery stops, restore no longer lists it", async () => {
    await start();
    const app = await pmSignIn(ALICE);
    const alice = await h!.signIn(ALICE);
    const { checkoutId } = await buy(alice, OFFER, "pay");
    expect((await verify(app.token)).body.decision).toBe("allow");
    const raw = JSON.stringify({ id: "evt_refund_repo", type: "payment.refunded", checkoutId, paymentId: `pay_test_${checkoutId}`, amount: 999, currency: "EUR" });
    expect((await fetch(`${h!.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": signTestEvent(h!.cfg.testPaymentWebhookSecret!, raw, h!.clock.t) }, body: raw })).status).toBe(200);
    expect((await verify(app.token)).body).toMatchObject({ decision: "deny", reason: "not_entitled" });
    expect(await pm(`package/${PKG}/authorize_download`, { token: app.token, architecture: "iphoneos-arm64" })).toMatchObject({ success: false });
    expect((await pm("user_info", { token: app.token })).items).not.toContain(PKG);
  });

  it("subscription eligibility follows HCG's period end; revocation by HCG applies immediately; a link already issued dies with it", async () => {
    await start();
    const app = await pmSignIn(CAROL);
    // HCG's subscription record (TEST ledger) for the Unleashed edition, ending in 3 days.
    const ends = h!.clock.t + 3 * 86_400_000;
    ledger().grant(CAROL.sub, "fixture.quasar.shell", "unleashed", "subscription", ends);
    const v = await verify(app.token);
    expect(v.body).toMatchObject({ decision: "allow", basis: "entitlement", validUntil: new Date(ends).toISOString() });
    h!.clock.advance(4 * 86_400);
    const app2 = await pmSignIn(CAROL); // the app signs in again after a long pause
    expect((await verify(app2.token)).body).toMatchObject({ decision: "deny", reason: "not_entitled" });
    // Renewed, then revoked by HCG.
    ledger().grant(CAROL.sub, "fixture.quasar.shell", "unleashed", "subscription", h!.clock.t + 30 * 86_400_000);
    const auth = await pm(`package/${PKG}/authorize_download`, { token: app2.token, architecture: "iphoneos-arm64" });
    expect(auth.url).toBeTruthy();
    ledger().revokeAll(CAROL.sub);
    expect((await verify(app2.token)).body).toMatchObject({ decision: "deny", reason: "not_entitled" });
    expect((await fetch(auth.url)).status).toBe(403); // re-checked at use
    // Signing out of the package manager ends the token for HCG Repo too.
    await pm("sign_out", { token: app2.token });
    expect((await verify(app2.token)).body).toMatchObject({ decision: "deny", reason: "token_invalid" });
  });
});

describe("temporary free testing through HCG Store's release lifecycle", () => {
  it("a published Store .deb in an open free testing window is allowed to anyone signed in, until the window ends; then only owners", async () => {
    await start({
      HCG_STORE_PUBLISHING: "enabled", HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER, HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve", HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
    });
    h!.idp.otherClients.add(MAKER);
    ledger().grant("pub", "hcg.store", featureEdition("store.publish"), "t", null);
    ledger().grant("rev", "hcg.store", featureEdition("store.release.approve"), "t", null);
    ledger().grant("rev", "hcg.store", featureEdition("store.release.publish"), "t", null);
    const deb = debPackage(PKG, "1.1.0", "iphoneos-arm64");
    const token = await h!.idp.accessToken({ sub: "pub", email: "pub@example.test", name: "Pub" }, MAKER);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(h!.origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return (await r.json()) as Record<string, any>;
    };
    const rel = await call("POST", "/api/v1/publishing/releases", { productId: "fixture-quasar-shell", editionId: "unleashed", version: "1.1.0", build: "110", channel: "stable", releaseNotes: ["TEST."], distribution: "free", eligibility: "public", destinations: ["hcg-repo"] });
    const sha = createHash("sha256").update(deb).digest("hex");
    const a = await call("POST", `/api/v1/publishing/releases/${rel.id}/artifacts`, { fileName: `${PKG}_1.1.0_iphoneos-arm64.deb`, platform: "ios", format: "deb", sizeBytes: deb.length, sha256: sha, architectures: ["iphoneos-arm64"], package: { id: PKG, version: "1.1.0", architecture: "iphoneos-arm64" }, buildProvider: "manual-upload" });
    await fetch(a.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${deb.length - 1}/${deb.length}` }, body: deb });
    expect((await call("POST", `/api/v1/publishing/artifacts/${a.artifact.id}/complete`)).artifact.status).toBe("verified");
    expect((await call("POST", `/api/v1/publishing/releases/${rel.id}/submit`)).status).toBe("submitted");
    const reviewer: Client = await h!.signIn({ sub: "rev", email: "rev@example.test", name: "Rev" });
    expect((await reviewer.post(`/api/v1/publishing/releases/${rel.id}/approve`, { eligibility: "public", confirm: "1.1.0" })).status).toBe(200);
    expect((await reviewer.post(`/api/v1/publishing/releases/${rel.id}/publish`, { confirm: "1.1.0" })).status).toBe(200);

    const app = await pmSignIn(BOB); // owns nothing
    expect((await verify(app.token, { version: "1.1.0" })).body).toMatchObject({ decision: "deny", reason: "not_entitled" });
    const w = openWindow(h!.db, { productId: "fixture-quasar-shell", editionId: "unleashed", releaseId: rel.id, period: { anchor: "fixed", startsAt: h!.clock.t, endsAt: h!.clock.t + 7 * 86_400_000 }, authorisedBy: "founder (TEST)", performedBy: "operator (TEST)" }, h!.clock.t);
    const free = await verify(app.token, { version: "1.1.0" });
    expect(free.body).toMatchObject({ decision: "allow", basis: "free-testing", validUntil: new Date(w.endsAt!).toISOString() });
    expect(free.body.eligibleVersions.map((x: { version: string }) => x.version)).toEqual(["1.1.0"]); // only the window's release
    const listing = (await s2s("GET", "/api/s2s/v1/repo/packages")).body.packages.find((x: { packageId: string }) => x.packageId === PKG);
    expect(listing.freeTesting).toMatchObject({ releaseId: rel.id });
    expect((await pm("user_info", { token: app.token })).items).toContain(PKG); // restore shows it while free
    terminateWindow(h!.db, w.id, "TEST: testing period over", { authorisedBy: "founder (TEST)", performedBy: "operator (TEST)" }, h!.clock.t);
    expect((await verify(app.token, { version: "1.1.0" })).body).toMatchObject({ decision: "deny", reason: "not_entitled" });
  });
});

describe("production posture", () => {
  it("with payments off, a package manager is told the package is not for sale and nothing is granted", async () => {
    await start({ HCG_STORE_PAYMENT_PROVIDER: "none", HCG_STORE_PROTECTED_DOWNLOADS: "disabled" });
    const app = await pmSignIn(ALICE);
    expect(await pm(`package/${PKG}/purchase`, { token: app.token, payment_secret: app.secret })).toMatchObject({ status: -1 });
    // Zebra's signed-out GET probe answers without an account (and without purchase state).
    const probe = await fetch(`${h!.origin}/repo-api/v1/sileo/package/${PKG}/info`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ purchased: 0, available: 0 });
    const listing = await s2s("GET", "/api/s2s/v1/repo/packages");
    expect(listing.body.payments).toBe("disabled");
    expect(listing.body.packages.find((x: { packageId: string }) => x.packageId === PKG).downloadsEnabled).toBe(false);
    ledger().grant(ALICE.sub, "fixture.quasar.shell", "unleashed", "test", null);
    expect((await verify(app.token)).body).toMatchObject({ decision: "deny", reason: "downloads_not_available", entitled: true });
  });
});

/** A minimal Debian package (ar: debian-binary, control.tar.gz with ./control, data.tar.gz). */
function debPackage(pkg: string, version: string, arch: string): Buffer {
  const tar = (files: { name: string; data: Buffer }[]) => {
    const parts: Buffer[] = [];
    for (const f of files) {
      const hd = Buffer.alloc(512);
      hd.write(f.name, 0); hd.write("0000644\0", 100); hd.write("0000000\0", 108); hd.write("0000000\0", 116);
      hd.write(f.data.length.toString(8).padStart(11, "0") + "\0", 124); hd.write("00000000000\0", 136); hd.write("        ", 148); hd.write("0", 156); hd.write("ustar\0", 257); hd.write("00", 263);
      hd.write(hd.reduce((x, y) => x + y, 0).toString(8).padStart(6, "0") + "\0 ", 148);
      parts.push(hd, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
    }
    return Buffer.concat([...parts, Buffer.alloc(1024)]);
  };
  const member = (name: string, data: Buffer) => {
    const hd = Buffer.alloc(60, " ");
    hd.write(name, 0); hd.write("0", 16); hd.write("0", 28); hd.write("0", 34); hd.write("100644", 40); hd.write(String(data.length), 48); hd.write("`\n", 58);
    return Buffer.concat([hd, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
  };
  const control = gzipSync(tar([{ name: "./control", data: Buffer.from(`Package: ${pkg}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: HCG\nDescription: TEST\n`) }]));
  const data = gzipSync(tar([{ name: "./usr/bin/sample", data: randomBytes(64) }]));
  return Buffer.concat([Buffer.from("!<arch>\n"), member("debian-binary", Buffer.from("2.0\n")), member("control.tar.gz", control), member("data.tar.gz", data)]);
}
