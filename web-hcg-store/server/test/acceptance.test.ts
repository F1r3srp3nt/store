// @vitest-environment node
/**
 * Acceptance tests for sign-in, ownership, purchases and protected delivery. They run the real
 * server code against a mock HCG Connect provider (same protocol as the live provider) and the
 * TEST payment provider. Numbers refer to the acceptance list in docs/ACCESS.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signTestEvent } from "../src/payments";
import type { TestLedgerAuthority } from "../src/entitlements";
import { buy, enableSileoProvider, FILES, FIXTURE_REPO, sha, startHarness, type Client, type Harness } from "./harness";

const ALICE = { sub: "user-alice", email: "alice@example.test", name: "Alice" };
const BOB = { sub: "user-bob", email: "bob@example.test", name: "Bob" };
const ADMIN = { sub: "user-admin", email: "admin@example.test", role: "admin" };
const DEB = "fixture-quasar-unleashed-1-0-0-arm64";
const IPA = "fixture-quasar-standard-1-0-0";
const UNLEASHED_OFFER = "fixture-quasar-unleashed-test";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

async function owner(): Promise<Client> {
  const c = await h.signIn(ALICE);
  const r = await buy(c, UNLEASHED_OFFER, "pay");
  expect(r.start.status).toBe(201);
  return c;
}

async function access(c: Client, edition = "unleashed") {
  const r = await c.get(`/api/v1/products/fixture-quasar-shell/access?edition=${edition}`);
  const body = (await r.json()) as { editions: { state: string; owned: boolean; downloadsAvailable: boolean; artifacts: { id: string }[] }[] };
  return body.editions[0]!;
}

describe("1. logged-out users cannot retrieve protected binaries", () => {
  it("refuses every protected download without a session", async () => {
    const anon = h.anonymous();
    for (const id of [DEB, IPA, "does-not-exist"]) {
      const r = await anon.get(`/api/v1/downloads/${id}`);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain("FIXTURE DEB");
    }
  });

  it("does not treat a forged or stale cookie as a session", async () => {
    const anon = h.anonymous();
    anon.cookies.set("hcg_store_session", "x".repeat(43));
    expect((await anon.get(`/api/v1/downloads/${DEB}`)).status).toBe(401);
  });

  it("reports signed-out access and no files on product pages", async () => {
    const a = await access(h.anonymous());
    expect(a).toMatchObject({ state: "signed-out", owned: false, downloadsAvailable: false, artifacts: [] });
  });
});

describe("2. signed-in users without an entitlement cannot download paid products", () => {
  it("refuses the download and offers the product for sale", async () => {
    const bob = await h.signIn(BOB);
    const r = await bob.get(`/api/v1/downloads/${DEB}`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_entitled");
    expect(await access(bob)).toMatchObject({ state: "not-owned", owned: false });
  });

  it("does not grant ownership because of an HCG account role", async () => {
    const admin = await h.signIn(ADMIN);
    expect((await admin.get(`/api/v1/downloads/${DEB}`)).status).toBe(403);
    expect(await access(admin)).toMatchObject({ state: "not-owned", owned: false });
  });

  it("requires sign-in for free products too (release policy), and never infers ownership", async () => {
    // Products without an offer and without an entitlement are not downloadable by anyone signed in.
    const bob = await h.signIn(BOB);
    expect((await bob.get(`/api/v1/downloads/${IPA}`)).status).toBe(403);
  });
});

describe("3. authorised owners download the correct artifact", () => {
  it("delivers exactly the purchased edition's file, privately", async () => {
    const alice = await owner();
    const a = await access(alice);
    expect(a).toMatchObject({ state: "owned", owned: true, downloadsAvailable: true });
    expect(a.artifacts.map((x) => x.id)).toEqual([DEB]);

    const r = await alice.get(`/api/v1/downloads/${DEB}`);
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(sha(bytes)).toBe(sha(FILES["quasar/unleashed-1.0.0-arm64.deb"]));
    expect(r.headers.get("content-disposition")).toContain("com.example.fixture.quasar.unleashed_1.0.0_iphoneos-arm64.deb");
    expect(r.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(r.headers.get("vary")).toContain("Cookie");
  });

  it("does not let one edition's purchase unlock another edition", async () => {
    const alice = await owner();
    expect((await alice.get(`/api/v1/downloads/${IPA}`)).status).toBe(403);
    expect(await access(alice, "standard")).toMatchObject({ state: "not-owned", owned: false });
  });
});

describe("4. failed payments and forged success redirects grant nothing", () => {
  it("a failed payment grants nothing", async () => {
    const bob = await h.signIn(BOB);
    const { checkoutId } = await buy(bob, UNLEASHED_OFFER, "fail");
    expect((await (await bob.get(`/api/v1/checkout/${checkoutId}`)).json()) as object).toMatchObject({ status: "failed" });
    expect(await access(bob)).toMatchObject({ owned: false });
    expect((await bob.get(`/api/v1/downloads/${DEB}`)).status).toBe(403);
  });

  it("a pending payment grants nothing until the provider confirms it", async () => {
    const bob = await h.signIn(BOB);
    const { checkoutId } = await buy(bob, UNLEASHED_OFFER, "pending");
    expect((await (await bob.get(`/api/v1/checkout/${checkoutId}`)).json()) as object).toMatchObject({ status: "pending" });
    expect(await access(bob)).toMatchObject({ owned: false });
  });

  it("visiting the success/return URL or a forged one grants nothing", async () => {
    const bob = await h.signIn(BOB);
    const start = await bob.post("/api/v1/checkout", { offerId: UNLEASHED_OFFER });
    const { checkoutId } = (await start.json()) as { checkoutId: string };
    for (const path of [
      `/checkout/return?checkout=${checkoutId}`,
      `/checkout/return?checkout=${checkoutId}&status=success&paid=1`,
      `/checkout/success?offer=${UNLEASHED_OFFER}`,
    ]) {
      await bob.get(path);
    }
    expect(await access(bob)).toMatchObject({ owned: false });
    expect(h.app.ledger.purchasesFor(BOB.sub)).toHaveLength(0);
  });

  it("rejects unsigned, wrongly signed, stale and tampered provider events", async () => {
    const bob = await h.signIn(BOB);
    const start = await bob.post("/api/v1/checkout", { offerId: UNLEASHED_OFFER });
    const { checkoutId } = (await start.json()) as { checkoutId: string };
    const event = { id: "evt_forged", type: "checkout.completed", checkoutId, paymentId: "pay_x", amount: 999, currency: "EUR" };
    const raw = JSON.stringify(event);
    const post = (body: string, sig?: string) =>
      fetch(`${h.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: sig ? { "hcg-test-signature": sig } : {}, body });
    expect((await post(raw)).status).toBe(400);
    expect((await post(raw, signTestEvent("wrong-secret", raw, h.clock.t))).status).toBe(400);
    expect((await post(raw, signTestEvent(h.cfg.testPaymentWebhookSecret!, raw, h.clock.t - 10 * 60 * 1000))).status).toBe(400);
    // Correctly signed, but paying less than the server's price: rejected.
    const cheap = JSON.stringify({ ...event, id: "evt_cheap", amount: 1 });
    const r = await post(cheap, signTestEvent(h.cfg.testPaymentWebhookSecret!, cheap, h.clock.t));
    expect(((await r.json()) as { outcome: string }).outcome).toBe("rejected");
    expect(await access(bob)).toMatchObject({ owned: false });
  });

  it("ignores client-supplied prices: only an offer ID is accepted", async () => {
    const bob = await h.signIn(BOB);
    const r = await bob.post("/api/v1/checkout", { offerId: UNLEASHED_OFFER, unitAmount: 1, currency: "USD" });
    const { checkoutId } = (await r.json()) as { checkoutId: string };
    expect(h.app.ledger.checkout(checkoutId)).toMatchObject({ amount: 999, currency: "EUR" });
    expect((await bob.post("/api/v1/checkout", { offerId: "made-up-offer" })).status).toBe(404);
  });

  it("refuses cross-site checkout and logout requests", async () => {
    const bob = await h.signIn(BOB);
    const r = await bob.request("/api/v1/checkout", {
      method: "POST",
      json: { offerId: UNLEASHED_OFFER },
      sameOrigin: false,
      headers: { origin: "https://evil.example" },
    });
    expect(r.status).toBe(403);
  });
});

describe("5. duplicate payment events do not duplicate purchases", () => {
  it("applies a replayed event once", async () => {
    const bob = await h.signIn(BOB);
    const start = await bob.post("/api/v1/checkout", { offerId: UNLEASHED_OFFER });
    const { checkoutId } = (await start.json()) as { checkoutId: string };
    const raw = JSON.stringify({ id: "evt_once", type: "checkout.completed", checkoutId, paymentId: "pay_once", amount: 999, currency: "EUR" });
    const sig = signTestEvent(h.cfg.testPaymentWebhookSecret!, raw, h.clock.t);
    const send = () => fetch(`${h.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": sig }, body: raw });
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(((await (await send()).json()) as { outcome: string }).outcome);
    expect(outcomes).toEqual(["processed", "duplicate", "duplicate"]);
    // A second, different completion event for the same checkout is also ignored.
    const raw2 = JSON.stringify({ id: "evt_twice", type: "checkout.completed", checkoutId, paymentId: "pay_twice", amount: 999, currency: "EUR" });
    const r2 = await fetch(`${h.origin}/api/v1/payments/webhook/test`, {
      method: "POST",
      headers: { "hcg-test-signature": signTestEvent(h.cfg.testPaymentWebhookSecret!, raw2, h.clock.t) },
      body: raw2,
    });
    expect(((await r2.json()) as { outcome: string }).outcome).toBe("ignored");
    expect(h.app.ledger.purchasesFor(BOB.sub)).toHaveLength(1);
  });

  it("refuses a second checkout for a product already owned", async () => {
    const alice = await owner();
    expect((await alice.post("/api/v1/checkout", { offerId: UNLEASHED_OFFER })).status).toBe(409);
  });
});

describe("6. logout, session expiry and revocation", () => {
  it("logout ends access immediately", async () => {
    const alice = await owner();
    const cookie = alice.cookieHeader();
    expect((await alice.post("/auth/logout")).status).toBe(200);
    expect(alice.cookies.size).toBe(0);
    // Even a stolen copy of the old cookie no longer works.
    const r = await fetch(`${h.origin}/api/v1/downloads/${DEB}`, { headers: { cookie } });
    expect(r.status).toBe(401);
    expect(((await (await alice.get("/api/v1/session")).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });

  it("restores the session on a later visit, and ends it after the idle limit", async () => {
    const alice = await owner();
    h.clock.advance(3 * 24 * 3600);
    expect(((await (await alice.get("/api/v1/session")).json()) as { signedIn: boolean }).signedIn).toBe(true);
    h.clock.advance(8 * 24 * 3600);
    expect(((await (await alice.get("/api/v1/session")).json()) as { signedIn: boolean }).signedIn).toBe(false);
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(401);
  });

  it("ends the Store session when HCG reports the central session ended", async () => {
    const alice = await owner();
    h.idp.endSessionsFor(ALICE.sub);
    // Inside the re-check window the last confirmation still stands…
    h.clock.advance(30);
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(200);
    // …after it, the next protected request re-confirms with HCG and is refused.
    h.clock.advance(31);
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(401);
    expect(((await (await alice.get("/api/v1/session")).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });

  it("does not treat an HCG outage as a denial or a grant", async () => {
    const alice = await owner();
    h.idp.down = true;
    h.clock.advance(120);
    const r = await alice.get(`/api/v1/downloads/${DEB}`);
    expect(r.status).toBe(503);
    expect((await access(alice)).state).toBe("unavailable");
    h.idp.down = false;
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(200);
  });

  it("entitlement revocation (refund) applies to the next request", async () => {
    const alice = await owner();
    const [purchase] = h.app.ledger.purchasesFor(ALICE.sub);
    const chk = (h.app.deps.db.prepare("SELECT checkout_id FROM purchases WHERE id = ?").get(purchase!.id) as { checkout_id: string }).checkout_id;
    const raw = JSON.stringify({ id: "evt_refund", type: "payment.refunded", checkoutId: chk, paymentId: `pay_test_${chk}`, amount: 999, currency: "EUR" });
    await fetch(`${h.origin}/api/v1/payments/webhook/test`, {
      method: "POST",
      headers: { "hcg-test-signature": signTestEvent(h.cfg.testPaymentWebhookSecret!, raw, h.clock.t) },
      body: raw,
    });
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(403);
    expect(h.app.ledger.purchasesFor(ALICE.sub)[0]!.status).toBe("refunded");
  });

  it("revocation by HCG (administrator) applies to the next request", async () => {
    const alice = await owner();
    (h.authority as TestLedgerAuthority).revokeAll(ALICE.sub);
    expect((await alice.get(`/api/v1/downloads/${DEB}`)).status).toBe(403);
  });

  it("subscriptions keep access until the paid period ends after cancellation, then expire", async () => {
    const alice = await h.signIn(ALICE);
    const { checkoutId } = await buy(alice, "fixture-quasar-standard-monthly-test", "pay");
    expect((await alice.get(`/api/v1/downloads/${IPA}`)).status).toBe(200);
    const raw = JSON.stringify({ id: "evt_cancel", type: "subscription.canceled", checkoutId, paymentId: "p", amount: 299, currency: "EUR" });
    await fetch(`${h.origin}/api/v1/payments/webhook/test`, {
      method: "POST",
      headers: { "hcg-test-signature": signTestEvent(h.cfg.testPaymentWebhookSecret!, raw, h.clock.t) },
      body: raw,
    });
    expect((await alice.get(`/api/v1/downloads/${IPA}`)).status).toBe(200);
    h.clock.advance(31 * 24 * 3600);
    const again = await h.signIn(ALICE);
    expect((await again.get(`/api/v1/downloads/${IPA}`)).status).toBe(403);
  });
});

describe("7. Store website and app report the same ownership", () => {
  it("library, product page, HCG Repo page and Sileo agree", async () => {
    const alice = await owner();
    const lib = (await (await alice.get("/api/v1/library")).json()) as { owned: { productId: string; editionId: string }[]; purchases: unknown[] };
    expect(lib.owned).toEqual([expect.objectContaining({ productId: "fixture-quasar-shell", editionId: "unleashed" })]);
    expect(lib.purchases).toHaveLength(1);
    expect((await access(alice)).owned).toBe(true);

    const repo = (await (await alice.get("/api/v1/repo/products/fixture-quasar-unleashed/access")).json()) as { state: string };
    expect(repo.state).toBe("owned");

    enableSileoProvider(h);
    const sileo = await sileoSignIn(ALICE);
    const info = await sileoPost("user_info", { token: sileo.token });
    expect(info.items).toEqual(["com.example.fixture.quasar.unleashed"]);
    // My Library v2: the Sileo connection is listed as a connection, never as an installation; no invoice is invented.
    const lib2 = (await (await alice.get("/api/v1/library")).json()) as Record<string, any>;
    expect(lib2.owned[0]).toMatchObject({ acquisition: "licensed", licence: "Active HCG licence", hcgRepoKey: expect.any(String) });
    expect(lib2.devices).toEqual([expect.objectContaining({ kind: "sileo", label: "Sileo (HCG Repo) on iPhone14,2" })]);
    expect(lib2.devicesNote).toMatch(/not an installation/);
    expect(lib2.invoices).toMatchObject({ available: false, items: [] });
    expect(JSON.stringify(lib2)).not.toMatch(/installed"|"installedVersion|updateAvailable/);
    const pkg = await sileoPost("package/com.example.fixture.quasar.unleashed/info", { token: sileo.token });
    expect(pkg).toMatchObject({ purchased: 1 });

    const bob = await h.signIn(BOB);
    expect(((await (await bob.get("/api/v1/library")).json()) as { owned: unknown[] }).owned).toEqual([]);
    expect(((await (await bob.get("/api/v1/repo/products/fixture-quasar-unleashed/access")).json()) as { state: string }).state).toBe("not-owned");
  });
});

describe("8. no public artifact URL bypasses the gate", () => {
  it("never serves private storage through the static site or path tricks", async () => {
    const anon = h.anonymous();
    for (const p of ["/quasar/unleashed-1.0.0-arm64.deb", "/../quasar/unleashed-1.0.0-arm64.deb", "/%2e%2e/quasar/unleashed-1.0.0-arm64.deb", "/storage/quasar/unleashed-1.0.0-arm64.deb"]) {
      const r = await anon.get(p);
      expect(await r.text()).not.toContain("FIXTURE DEB");
    }
  });

  it("Sileo download grants are single-use, short-lived, opaque and re-check ownership", async () => {
    await owner();
    enableSileoProvider(h);
    const s = await sileoSignIn(ALICE);
    const grant = async () => (await sileoPost("package/com.example.fixture.quasar.unleashed/authorize_download", { token: s.token, version: "1.0.0", architecture: "iphoneos-arm64", repo: FIXTURE_REPO })).url as string;
    const url = await grant();
    expect(url.startsWith(h.origin + "/api/sileo/v1/download/")).toBe(true);
    expect(url).not.toContain(s.token);
    expect(url).not.toContain("user-alice");
    expect((await fetch(url)).status).toBe(200);
    // Single use: replaying the same URL is refused.
    expect((await fetch(url)).status).toBe(403);
    // Tampering finds nothing.
    const other = await grant();
    expect((await fetch(other.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status).toBe(403);
    // After expiry it no longer works.
    h.clock.advance(h.cfg.downloadUrlTtlSeconds + 1);
    expect((await fetch(other)).status).toBe(403);
    // The retired signed-URL scheme answers "gone".
    expect((await fetch(`${h.origin}/repo-api/v1/files/abc.def`)).status).toBe(410);
  });

  it("Sileo tokens stop working after sign-out and never authorise non-owners", async () => {
    enableSileoProvider(h);
    const bob = await sileoSignIn(BOB);
    const denied = await sileoPost("package/com.example.fixture.quasar.unleashed/authorize_download", { token: bob.token, version: "1.0.0", architecture: "iphoneos-arm64", repo: FIXTURE_REPO });
    expect(denied.success).toBe(false);
    const purchase = await sileoPost("package/com.example.fixture.quasar.unleashed/purchase", { token: bob.token, payment_secret: bob.secret });
    expect(purchase.status).toBe(1); // checkout happens in HCG Store; nothing is granted here
    expect(await access(await h.signIn(BOB))).toMatchObject({ owned: false });
    await sileoPost("sign_out", { token: bob.token });
    const after = await sileoPost("user_info", { token: bob.token });
    expect(after).toMatchObject({ success: false, invalidate: true });
  });

  it("with the launch switch off, owners get 'Downloads are not available yet.' everywhere", async () => {
    await h.stop();
    h = await startHarness({ env: { HCG_STORE_PROTECTED_DOWNLOADS: "disabled" } });
    const alice = await owner();
    const r = await alice.get(`/api/v1/downloads/${DEB}`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toBe("Downloads are not available yet.");
    expect(await access(alice)).toMatchObject({ owned: true, downloadsAvailable: false, artifacts: [] });
    enableSileoProvider(h);
    const s = await sileoSignIn(ALICE);
    const auth = await sileoPost("package/com.example.fixture.quasar.unleashed/authorize_download", { token: s.token, version: "1.0.0", architecture: "iphoneos-arm64", repo: FIXTURE_REPO });
    expect(auth).toMatchObject({ success: false, error: "Downloads are not available yet." });
  });

  it("marks every API response private and uncacheable", async () => {
    const alice = await owner();
    for (const p of ["/api/v1/session", "/api/v1/library", "/api/v1/offers", "/api/v1/products/fixture-quasar-shell/access", "/api/v1/repo/products/fixture-quasar-unleashed/access"]) {
      const r = await alice.get(p);
      expect(r.headers.get("cache-control"), p).toBe("private, no-store, max-age=0");
      expect(r.headers.get("vary"), p).toContain("Cookie");
    }
  });

  it("keeps protected files out of the built public site", () => {
    const dist = join(import.meta.dirname, "../../dist");
    let files: string[] = [];
    try {
      files = readdirSync(dist, { recursive: true }).map(String);
    } catch {
      return; // no build present; the e2e suite checks the built site
    }
    for (const f of files) {
      expect(f).not.toMatch(/\.(deb|ipa|dmg|pkg|exe|msi|apk|zip)$/);
      const full = join(dist, f);
      if (statSync(full).isFile() && statSync(full).size < 2_000_000) expect(readFileSync(full, "utf8")).not.toContain("dropbox.com/scl/");
    }
  });
});

describe("HCG Repo access endpoint", () => {
  it("allows only the configured HCG Repo origin to read access state with credentials", async () => {
    const r = await h.anonymous().get("/api/v1/repo/products/fixture-quasar-unleashed/access", { headers: { origin: "http://127.0.0.1:9" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:9");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await h.anonymous().get("/api/v1/repo/products/fixture-quasar-unleashed/access", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("maps the HCG Repo product to its Store page and buy link", async () => {
    const bob = await h.signIn(BOB);
    const body = (await (await bob.get("/api/v1/repo/products/fixture-quasar-unleashed/access")).json()) as Record<string, string>;
    expect(body.store_url).toBe(`${h.origin}/apps/fixture-quasar-shell?edition=unleashed`);
    expect(body.buy_url).toBe(`${h.origin}/apps/fixture-quasar-shell?edition=unleashed&buy=1`);
  });
});

// ---------------------------------------------------------------- Sileo client simulation

async function sileoPost(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${h.origin}/api/sileo/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Sileo/2.5.1 CFNetwork/1410.0.3 Darwin/22.6.0" },
    body: JSON.stringify({ udid: "fixture-udid", device: "iPhone14,2", ...body }),
  });
  return (await r.json()) as Record<string, unknown> & { items?: string[] };
}

/** Simulates Sileo's ASWebAuthenticationSession sign-in: authenticate → HCG Connect → sileo:// callback. */
async function sileoSignIn(user: { sub: string; email: string }) {
  h.idp.nextUser = user;
  const start = await fetch(`${h.origin}/api/sileo/v1/authenticate?udid=fixture-udid&model=iPhone14,2`, { redirect: "manual" });
  const authz = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const cb = await fetch(authz.headers.get("location")!, { redirect: "manual" });
  const loc = new URL(cb.headers.get("location")!);
  expect(loc.protocol).toBe("sileo:");
  expect(loc.host).toBe("authentication_success");
  expect(cb.headers.getSetCookie()).toEqual([]);
  return { token: loc.searchParams.get("token")!, secret: loc.searchParams.get("payment_secret")! };
}
