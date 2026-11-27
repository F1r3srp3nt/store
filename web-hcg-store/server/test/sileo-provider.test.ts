// @vitest-environment node
/**
 * HCG Store as HCG Repo's payment provider for Sileo and Zebra: protocol contract tests and the qualification
 * scenarios (founder brief, 27 Nov 2026). The simulated clients send exactly what Sileo (`c9f7015`,
 * PaymentProvider.swift / PaymentAuthenticator.swift) and Zebra (`e2f3c27`, ZBPaymentVendor.m) send, and parse the
 * answers the way they do. Everything runs against the TEST provider and mock HCG Connect: no money moves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signTestEvent } from "../src/payments";
import type { TestLedgerAuthority } from "../src/entitlements";
import { buy, enableSileoProvider, FILES, FIXTURE_PACKAGE, FIXTURE_REPO, sha, startHarness, type Client, type Harness } from "./harness";

const ALICE = { sub: "user-alice", email: "alice@example.test", name: "Alice" };
const BOB = { sub: "user-bob", email: "bob@example.test", name: "Bob" };
const FOUNDER = { sub: "user-founder", email: "founder@example.test", name: "Founder" };
const PKG = FIXTURE_PACKAGE;
const SILEO_UA = "Sileo/2.5.1 CFNetwork/1410.0.3 Darwin/22.6.0";
const ZEBRA_UA = "Zebra/1.1.32 CFNetwork/1410.0.3 Darwin/22.6.0";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.stop();
});

// ---------------------------------------------------------------- simulated clients

/** What Sileo's PaymentProvider does: JSON POST, udid + device always, token when signed in, payment_secret for purchases. */
class SileoClient {
  token: string | null = null;
  secret: string | null = null;
  constructor(public readonly udid = "00008110-001A2B3C4D5E6F70", public readonly device = "iPhone14,2", public readonly ua = SILEO_UA) {}
  get base() {
    return `${h.origin}/api/sileo/v1/`;
  }
  async post(path: string, extra: Record<string, unknown> = {}, opts: { secret?: boolean } = {}) {
    const body: Record<string, unknown> = { ...extra, udid: this.udid, device: this.device };
    if (this.token) body.token = this.token;
    if (opts.secret && this.secret) body.payment_secret = this.secret;
    const r = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/json", "user-agent": this.ua }, body: JSON.stringify(body) });
    const json = (await r.json()) as Record<string, any>;
    // Sileo's makeRequest: `success: false` or an `error` string is a failure; `invalidate` forgets the token.
    const failed = (json.success !== undefined && json.success !== true) || typeof json.error === "string";
    if (failed && json.invalidate === true) {
      this.token = null;
      this.secret = null;
    }
    return { status: r.status, json, failed };
  }
  /** ASWebAuthenticationSession on `authenticate?udid=&model=`, ending at the sileo:// callback. */
  async signIn(user: { sub: string; email: string; name?: string }) {
    h.idp.nextUser = user;
    const start = await fetch(`${this.base}authenticate?udid=${encodeURIComponent(this.udid)}&model=${encodeURIComponent(this.device)}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" } });
    if (start.status !== 302) return { ok: false as const, status: start.status, body: await start.text() };
    const authorize = new URL(start.headers.get("location")!);
    const authz = await fetch(authorize, { redirect: "manual" });
    const cb = await fetch(authz.headers.get("location")!, { redirect: "manual" });
    const loc = cb.headers.get("location");
    if (cb.status !== 302 || !loc) return { ok: false as const, status: cb.status, body: await cb.text(), authorize };
    const u = new URL(loc);
    // PaymentAuthenticator: host must be authentication_success and both values present.
    if (u.protocol !== "sileo:" || u.host !== "authentication_success") throw new Error(`unexpected callback ${u.protocol}//${u.host}`);
    this.token = u.searchParams.get("token");
    this.secret = u.searchParams.get("payment_secret");
    return { ok: true as const, authorize, callback: u, cookies: cb.headers.getSetCookie() };
  }
  async info() {
    const r = await fetch(this.base + "info", { headers: { "user-agent": this.ua } });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  }
  /** PaymentPackageInfo(dictionary:) — price String, purchased Int, available Int, or nil. */
  async packageInfo(pkg = PKG) {
    const r = await this.post(`package/${pkg}/info`);
    const j = r.json;
    const parsed = typeof j.price === "string" && Number.isInteger(j.purchased) && Number.isInteger(j.available) ? { price: j.price as string, purchased: j.purchased !== 0, available: j.available !== 0 } : null;
    return { ...r, parsed };
  }
  /** initiatePurchase: status Int in -1...1, url optional. */
  async purchase(pkg = PKG) {
    const r = await this.post(`package/${pkg}/purchase`, {}, { secret: true });
    return { ...r, statusCode: r.json.status as number | undefined, url: r.json.url as string | undefined };
  }
  /** downloadURL(for:from:): body version, repo, architecture; answer `url`, which must be https in the real client. */
  async authorize(extra: { version?: string; repo?: string; architecture?: string } = {}, pkg = PKG) {
    return this.post(`package/${pkg}/authorize_download`, { version: "1.0.0", repo: FIXTURE_REPO, architecture: "iphoneos-arm64", ...extra });
  }
}

/** The checkout page Sileo opens for status 1, then the TEST provider outcome the person picks. */
async function completeCheckout(actionUrl: string, outcome: "pay" | "fail" | "cancel") {
  const page = await fetch(actionUrl);
  const html = await page.text();
  const post = await fetch(actionUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: h.origin }, body: `outcome=${outcome}` });
  return { page, html, result: await post.text(), resultStatus: post.status };
}

function checkoutIdOf(sub: string) {
  return (h.db.prepare("SELECT id FROM checkout_sessions WHERE sub = ? ORDER BY created_at DESC LIMIT 1").get(sub) as { id: string } | undefined)?.id ?? null;
}

async function providerEvent(type: string, checkoutId: string, id = `evt_${type}_${checkoutId}`) {
  const raw = JSON.stringify({ id, type, checkoutId, paymentId: `pay_test_${checkoutId}`, amount: 999, currency: "EUR" });
  const r = await fetch(`${h.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": signTestEvent(h.cfg.testPaymentWebhookSecret!, raw, h.clock.t) }, body: raw });
  return (await r.json()) as { outcome: string };
}

async function buyInSileo(s: SileoClient) {
  const p = await s.purchase();
  expect(p.statusCode).toBe(1);
  const done = await completeCheckout(p.url!, "pay");
  expect(done.result).toContain("Purchase confirmed");
  return done;
}

// ---------------------------------------------------------------- contract

describe("protocol contract (as Sileo and Zebra parse it)", () => {
  it("GET info: name, description, icon and authentication_banner, with the official HCG Store profile", async () => {
    enableSileoProvider(h);
    const { status, json } = await new SileoClient().info();
    expect(status).toBe(200);
    expect(json).toEqual({
      name: "HCG Store",
      description: "Official payment and distribution services for Hakmi Capital Group.",
      icon: `${h.origin}/brand/icon-512.png`,
      authentication_banner: { message: "Sign in with your HCG account to purchase packages and access your existing purchases.", button: "Sign in with HCG Connect" },
    });
  });

  it("package info is answered without a token (Sileo POST and Zebra GET) with the server's price", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    const post = await s.packageInfo();
    expect(post.parsed).toEqual({ price: "€9.99", purchased: false, available: true });
    // Zebra tries GET first when signed out, falling back to POST on any error.
    const get = await fetch(`${h.origin}/api/sileo/v1/package/${PKG}/info`, { headers: { "user-agent": ZEBRA_UA, accept: "application/json" } });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ price: "€9.99", purchased: 0, available: 1 });
    // Zebra sends "none" as the token when it has none.
    const none = await s.post(`package/${PKG}/info`, { token: "none" });
    expect(none.json).toMatchObject({ price: "€9.99", purchased: 0 });
    // A package HCG Store does not distribute is an error the client ignores (no price shown).
    expect((await s.packageInfo("com.example.not.ours")).failed).toBe(true);
  });

  it("errors use { success: false, error } and an ended credential carries invalidate: true", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    s.token = "x".repeat(43);
    const r = await s.post("user_info");
    expect(r.json).toEqual({ success: false, error: "Your HCG sign-in has ended. Sign in again.", invalidate: true });
    expect(s.token).toBeNull();
  });

  it("the first path (/repo-api/v1/sileo/) stays an alias of /api/sileo/v1/", async () => {
    enableSileoProvider(h);
    const a = await (await fetch(`${h.origin}/repo-api/v1/sileo/info`)).json();
    const b = await (await fetch(`${h.origin}/api/sileo/v1/info`)).json();
    expect(a).toEqual(b);
  });

  it("every response is JSON and never cached by a shared cache", async () => {
    enableSileoProvider(h);
    const r = await fetch(`${h.origin}/api/sileo/v1/package/${PKG}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});

// ---------------------------------------------------------------- qualification 1-12

describe("qualification", () => {
  it("1. discovery: the internal test source advertises the provider only during internal testing; HCG Repo gets the endpoint only when public", async () => {
    enableSileoProvider(h, { availability: "internal" });
    const ep = await fetch(`${h.origin}/api/sileo/v1/internal-source/payment_endpoint`);
    expect(ep.status).toBe(200);
    // Sileo: trims, appends "/", requires https in production (http is a loopback test server here).
    expect((await ep.text()).trim()).toBe(`${h.origin}/api/sileo/v1/`);
    const packages = await (await fetch(`${h.origin}/api/sileo/v1/internal-source/Packages`)).text();
    expect(packages).toContain(`Package: ${PKG}`);
    expect(packages).toContain("Tag: cydia::commercial");
    expect(packages).toContain(`SHA256: ${sha(FILES["quasar/unleashed-1.0.0-arm64.deb"])}`);
    expect(packages).toMatch(/Filename: protected\//);
    const release = await (await fetch(`${h.origin}/api/sileo/v1/internal-source/Release`)).text();
    expect(release).toContain("INTERNAL TESTING ONLY");
    // The Filename in the index is never served.
    expect((await fetch(`${h.origin}/api/sileo/v1/internal-source/protected/x.deb`)).status).toBe(404);
    // Public: no internal source.
    enableSileoProvider(h, { availability: "public" });
    expect((await fetch(`${h.origin}/api/sileo/v1/internal-source/payment_endpoint`)).status).toBe(404);
    // Disabled: nothing answers.
    enableSileoProvider(h, { availability: "disabled" });
    expect((await fetch(`${h.origin}/api/sileo/v1/info`)).status).toBe(503);
    expect((await fetch(`${h.origin}/api/sileo/v1/internal-source/Packages`)).status).toBe(404);
  });

  it("2. official HCG Store branding (and the icon is the official artwork path)", async () => {
    enableSileoProvider(h);
    const { json } = await new SileoClient().info();
    expect(json.name).toBe("HCG Store");
    expect(json.icon).toBe(`${h.origin}/brand/icon-512.png`);
    expect(json.authentication_banner.button).toBe("Sign in with HCG Connect");
  });

  it("3. HCG Connect authentication: PKCE S256, scoped credentials on the callback, no cookie, nothing sensitive stored", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const r = await s.signIn(ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.cookies).toEqual([]);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Not an HCG Connect token (those are JWTs).
    expect(s.token!.split(".")).toHaveLength(1);
    // Stored only as hashes; the device identifier is not stored at all (a keyed hash binds the credential).
    const dump = JSON.stringify(h.db.prepare("SELECT * FROM repo_tokens").all()) + JSON.stringify(h.db.prepare("SELECT * FROM commerce_audit").all()) + JSON.stringify(h.db.prepare("SELECT * FROM auth_events").all());
    expect(dump).not.toContain(s.token!);
    expect(dump).not.toContain(s.secret!);
    expect(dump).not.toContain(s.udid);
    expect(dump).toContain("iPhone14,2");
    const user = await s.post("user_info");
    expect(user.json.user).toEqual({ name: "Alice", email: "alice@example.test" });
    expect(logs.join("\n")).not.toContain(s.token!);
  });

  it("4-9. prices, TEST purchase, webhook-only grant, purchased identifiers, authorised .deb, re-download on a new device", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    await s.signIn(BOB);
    // 5. Price shown before purchase, signed in.
    expect((await s.packageInfo()).parsed).toEqual({ price: "€9.99", purchased: false, available: true });
    expect((await s.post("user_info")).json.items).toEqual([]);
    // 6. Purchase: status 1 with the Store's checkout page.
    const p = await s.purchase();
    expect(p.statusCode).toBe(1);
    expect(p.url).toMatch(new RegExp(`^${h.origin}/api/sileo/v1/checkout/[A-Za-z0-9_-]{43}$`));
    expect(p.url).not.toContain(s.token!);
    // 7. Nothing is granted by opening the checkout page or by the purchase request.
    const page = await fetch(p.url!);
    const html = await page.text();
    expect(html).toContain("TEST MODE");
    expect(html).toContain("€9.99");
    expect((await s.packageInfo()).parsed?.purchased).toBe(false);
    const chk = checkoutIdOf(BOB.sub)!;
    // A forged webhook (bad signature) changes nothing.
    const forged = JSON.stringify({ id: "evt_forged", type: "checkout.completed", checkoutId: chk, paymentId: "x", amount: 999, currency: "EUR" });
    expect((await fetch(`${h.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": "t=1,v1=00" }, body: forged })).status).toBe(400);
    // A webhook with another amount than the server priced is rejected.
    const wrong = JSON.stringify({ id: "evt_wrong", type: "checkout.completed", checkoutId: chk, paymentId: "y", amount: 1, currency: "EUR" });
    const wr = await fetch(`${h.origin}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": signTestEvent(h.cfg.testPaymentWebhookSecret!, wrong, h.clock.t) }, body: wrong });
    expect(((await wr.json()) as { outcome: string }).outcome).toBe("rejected");
    expect((await s.packageInfo()).parsed?.purchased).toBe(false);
    // The person confirms on the TEST provider page; the provider's signed event grants the entitlement.
    const done = await completeCheckout(p.url!, "pay");
    expect(done.result).toContain("Purchase confirmed");
    expect(done.result).toContain('href="sileo://payment_completed"');
    // Duplicate delivery of the provider's event is processed once.
    expect((await providerEvent("checkout.completed", chk, "evt_dup")).outcome).toBe("ignored");
    expect((await providerEvent("checkout.completed", chk, "evt_dup")).outcome).toBe("duplicate");
    expect(h.app.ledger.purchasesFor(BOB.sub)).toHaveLength(1);
    expect(h.app.ledger.purchasesFor(BOB.sub)[0]).toMatchObject({ channel: "package-manager", amount: 999, currency: "EUR", status: "paid", version_at_purchase: "1.0.0" });
    // 4. Purchased identifiers.
    expect((await s.post("user_info")).json.items).toEqual([PKG]);
    expect((await s.packageInfo()).parsed).toEqual({ price: "Purchased", purchased: true, available: true });
    // A second purchase attempt is an immediate success, never a second charge.
    expect((await s.purchase()).statusCode).toBe(0);
    // 8. Authorised download of the exact .deb.
    const a = await s.authorize();
    expect(a.json.url).toMatch(new RegExp(`^${h.origin}/api/sileo/v1/download/[A-Za-z0-9_-]{43}$`));
    const dl = await fetch(a.json.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(sha(bytes)).toBe(sha(FILES["quasar/unleashed-1.0.0-arm64.deb"]));
    // Debian revision of the same release is accepted (HCG Repo indexes e.g. 1.0.0-1).
    expect((await s.authorize({ version: "1.0.0-1" })).json.url).toBeTruthy();
    // 9. Another device, new sign-in: the earlier purchase is honoured.
    const ipad = new SileoClient("00008103-000A1B2C3D4E5F60", "iPad13,4");
    await ipad.signIn(BOB);
    expect((await ipad.post("user_info")).json.items).toEqual([PKG]);
    const again = await ipad.authorize();
    expect((await fetch(again.json.url)).status).toBe(200);
    // One history: the Store website shows the Sileo purchase.
    const web = await h.signIn(BOB);
    const lib = (await (await web.get("/api/v1/library")).json()) as Record<string, any>;
    expect(lib.purchases).toEqual([expect.objectContaining({ channel: "package-manager", receiptNumber: expect.stringMatching(/^pur_/), refund: "none" })]);
    expect(lib.packageManagers.filter((d: { status: string }) => d.status === "active")).toHaveLength(2);
  });

  it("10. unauthorised, expired, replayed and mismatched download attempts are denied", async () => {
    enableSileoProvider(h);
    const alice = new SileoClient();
    await alice.signIn(ALICE);
    await buyInSileo(alice);
    const bob = new SileoClient("00008110-00BBBBBBBBBBBBBB");
    await bob.signIn(BOB);
    expect((await bob.authorize()).json).toMatchObject({ success: false, error: "Your HCG account does not include this package." });
    // Another version, architecture, repository or package than what was approved.
    expect((await alice.authorize({ version: "2.0.0" })).json).toMatchObject({ success: false, error: "No approved file matches this version and architecture." });
    expect((await alice.authorize({ version: "1.0.0+evil" })).json.success).toBe(false);
    expect((await alice.authorize({ architecture: "iphoneos-arm" })).json.success).toBe(false);
    expect((await alice.authorize({ repo: "https://evil.example/repo/" })).json).toMatchObject({ success: false, error: "This repository is not associated with HCG Store for this package." });
    expect((await alice.authorize({}, "com.example.other")).json.success).toBe(false);
    // Grants: replay, expiry, tampering.
    const g1 = (await alice.authorize()).json.url as string;
    expect((await fetch(g1)).status).toBe(200);
    expect((await fetch(g1)).status).toBe(403);
    const g2 = (await alice.authorize()).json.url as string;
    h.clock.advance(h.cfg.downloadUrlTtlSeconds + 1);
    expect((await fetch(g2)).status).toBe(403);
    expect((await fetch(`${h.origin}/api/sileo/v1/download/${"A".repeat(43)}`)).status).toBe(403);
    // A credential copied to another device is refused and forgotten by the client.
    const thief = new SileoClient("00008110-00DEADBEEFDEADBE");
    thief.token = alice.token;
    const stolen = await thief.authorize();
    expect(stolen.json).toMatchObject({ success: false, invalidate: true });
    // Paid package bytes never reach anyone through public paths.
    for (const path of ["/quasar/unleashed-1.0.0-arm64.deb", "/api/sileo/v1/internal-source/protected/com.example.fixture.quasar.unleashed_1.0.0_iphoneos-arm64.deb", "/repo/debs/com.example.fixture.quasar.unleashed_1.0.0_iphoneos-arm64.deb"]) {
      const r = await fetch(h.origin + path);
      expect(await r.text()).not.toContain("FIXTURE DEB");
    }
  });

  it("11. refunds, disputes and session revocation are enforced, including on grants already issued", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    await s.signIn(ALICE);
    await buyInSileo(s);
    const chk = checkoutIdOf(ALICE.sub)!;
    const pending = (await s.authorize()).json.url as string;
    expect((await providerEvent("payment.refunded", chk)).outcome).toBe("processed");
    expect((await fetch(pending)).status).toBe(403);
    expect((await s.authorize()).json).toMatchObject({ success: false, error: "Your HCG account does not include this package." });
    expect((await s.post("user_info")).json.items).toEqual([]);
    expect((await s.packageInfo()).parsed?.purchased).toBe(false);
    const web = await h.signIn(ALICE);
    const receipt = (await (await web.get(`/api/v1/account/receipts/${h.app.ledger.purchasesFor(ALICE.sub)[0]!.id}`)).json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({ refund: "refunded", status: "refunded", channel: "package-manager", testMode: true });

    // Dispute on a second account's purchase.
    const b = new SileoClient("00008110-00CCCCCCCCCCCCCC");
    await b.signIn(BOB);
    await buyInSileo(b);
    expect((await providerEvent("payment.disputed", checkoutIdOf(BOB.sub)!)).outcome).toBe("processed");
    expect((await b.authorize()).json.success).toBe(false);

    // Revocation from the account page (founder: a paid licence granted centrally, then revoked device by device).
    (h.authority as TestLedgerAuthority).grant(FOUNDER.sub, "fixture.quasar.shell", "unleashed", "licence", null);
    const f1 = new SileoClient("00008110-00F1F1F1F1F1F1F1");
    const f2 = new SileoClient("00008110-00F2F2F2F2F2F2F2", "iPhone15,3");
    await f1.signIn(FOUNDER);
    await f2.signIn(FOUNDER);
    const issued = (await f1.authorize()).json.url as string;
    const founderWeb = await h.signIn(FOUNDER);
    const list = (await (await founderWeb.get("/api/v1/account/package-managers")).json()) as { packageManagers: { ref: string; deviceModel: string; status: string }[] };
    expect(JSON.stringify(list)).not.toContain(f1.token!);
    const ref = list.packageManagers.find((d) => d.status === "active" && d.deviceModel === "iPhone14,2")!.ref;
    // CSRF: a request from another site is refused.
    expect((await founderWeb.post(`/api/v1/account/package-managers/${ref}/revoke`, {}, { sameOrigin: false, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await founderWeb.post(`/api/v1/account/package-managers/${ref}/revoke`)).status).toBe(200);
    expect((await f1.post("user_info")).json).toMatchObject({ success: false, invalidate: true });
    expect((await fetch(issued)).status).toBe(403);
    expect((await f2.post("user_info")).json.items).toEqual([PKG]);
    const all = await founderWeb.post("/api/v1/account/package-managers/revoke-all");
    expect(((await all.json()) as { revoked: number }).revoked).toBe(1);
    expect((await f2.post("user_info")).json).toMatchObject({ invalidate: true });
    // Sign-out from Sileo ends the credential too.
    const s2 = new SileoClient();
    await s2.signIn(BOB);
    const token = s2.token;
    expect((await s2.post("sign_out")).json).toEqual({ success: true });
    s2.token = token;
    expect((await s2.post("user_info")).json).toMatchObject({ invalidate: true });
  });

  it("12. free packages stay out of the provider: nothing to buy, and HCG Repo installs them directly", async () => {
    // An edition with no price set (HCG sells nothing for it): distributed to any signed-in HCG account.
    const sold = h.app.deps.registry.offers;
    h.app.deps.registry.offers = sold.filter((o) => o.editionId !== "unleashed");
    enableSileoProvider(h, { access: "account" });
    const s = new SileoClient();
    // A sign-in-only package shows "Free" and never starts a checkout.
    expect((await s.packageInfo()).parsed).toMatchObject({ price: "Free", purchased: false });
    await s.signIn(BOB);
    expect((await s.purchase()).statusCode).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM checkout_sessions").get()).toEqual({ n: 0 });
    // A "free" channel (HCG Repo's public pool) is never authorised through the provider.
    h.app.deps.registry.offers = sold;
    const c = h.app.commerce;
    const problems = c.channelProblems(PKG, { productId: "fixture-quasar-shell", editionId: "unleashed", status: "active", access: "free", architectures: ["iphoneos-arm64"], minIos: null, maxIos: null, updatePolicy: "all-updates", repository: FIXTURE_REPO });
    expect(problems.join(" ")).toMatch(/offers approved for sale/);
  });
});

// ---------------------------------------------------------------- payments and gates

describe("payments, gates and internal testing", () => {
  it("failed and cancelled TEST payments grant nothing, and payments off refuses purchases without a checkout", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    await s.signIn(BOB);
    const p1 = await s.purchase();
    expect((await completeCheckout(p1.url!, "fail")).result).toContain("Payment failed");
    const p2 = await s.purchase();
    expect((await completeCheckout(p2.url!, "cancel")).result).toContain("Purchase cancelled");
    expect((await s.packageInfo()).parsed?.purchased).toBe(false);
    expect(h.app.ledger.purchasesFor(BOB.sub)).toEqual([]);
    // A used page cannot be paid again after cancelling.
    const again = await fetch(p2.url!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: h.origin }, body: "outcome=pay" });
    expect(await again.text()).toContain("Purchase cancelled");
    expect(h.app.ledger.purchasesFor(BOB.sub)).toEqual([]);
    // A checkout form posted from another site is refused.
    const p3 = await s.purchase();
    const evil = await fetch(p3.url!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "outcome=pay" });
    expect(evil.status).toBe(403);
    // Expired checkout link.
    h.clock.advance(31 * 60);
    expect((await fetch(p3.url!)).status).toBe(410);

    enableSileoProvider(h, { paymentMode: "off" });
    const before = h.db.prepare("SELECT COUNT(*) AS n FROM checkout_sessions").get();
    const off = await s.purchase();
    expect(off.json).toEqual({ status: -1, error: "Purchases from package managers are not available yet. Nothing was charged." });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM checkout_sessions").get()).toEqual(before);
    expect((await s.packageInfo()).parsed).toMatchObject({ purchased: false, available: false });
  });

  it("a wrong payment secret ends the credential; a missing one (device without passcode) still needs the checkout page", async () => {
    enableSileoProvider(h);
    const s = new SileoClient();
    await s.signIn(BOB);
    const secret = s.secret;
    s.secret = "wrong-secret-wrong-secret-wrong";
    const r = await s.purchase();
    expect(r.json).toMatchObject({ success: false, invalidate: true });
    await s.signIn(BOB);
    s.secret = null;
    expect((await s.purchase()).statusCode).toBe(1);
    expect(secret).not.toBeNull();
  });

  it("same-major update policy: a purchase covers the major version it was bought for", async () => {
    enableSileoProvider(h, { updatePolicy: "same-major" });
    const s = new SileoClient();
    await s.signIn(BOB);
    await buyInSileo(s);
    expect((await s.authorize()).json.url).toBeTruthy();
    h.db.prepare("UPDATE purchases SET version_at_purchase = '0.9.0' WHERE sub = ?").run(BOB.sub);
    expect((await s.authorize()).json).toMatchObject({ success: false, error: "Your purchase does not include this major version. Check HCG Store for an upgrade." });
  });

  it("internal testing: only the Founder (confirmed by HCG) and HCG Store staff can sign in; public needs the server's founder approval", async () => {
    enableSileoProvider(h, { availability: "internal" });
    const r = await new SileoClient().signIn(BOB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body).toContain("internal testing");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM repo_tokens").get()).toEqual({ n: 0 });
    (h.authority as TestLedgerAuthority).setFounderPolicy(FOUNDER.sub, true);
    expect((await new SileoClient().signIn(FOUNDER)).ok).toBe(true);

    await h.stop();
    h = await startHarness({ env: { HCG_STORE_SILEO_PUBLIC_APPROVED: "" } });
    enableSileoProvider(h, { availability: "public" });
    expect(h.app.commerce.effective().availability).toBe("internal");
    expect((await new SileoClient().signIn(BOB)).ok).toBe(false);
    const health = (await (await fetch(`${h.origin}/api/v1/health`)).json()) as Record<string, unknown>;
    expect(health.packageManagerProvider).toBe("internal");
  });

  it("moving from public back to internal testing stops customers' existing credentials; a bound credential without its device identifier is refused", async () => {
    enableSileoProvider(h, { availability: "public" });
    const s = new SileoClient();
    await s.signIn(BOB);
    const token = s.token!;
    const bare = await fetch(`${h.origin}/api/sileo/v1/user_info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(await bare.json()).toMatchObject({ success: false, invalidate: true });
    s.token = token;
    expect((await s.post("user_info")).json.items).toEqual([]);
    enableSileoProvider(h, { availability: "internal" });
    expect((await s.post("user_info")).json).toMatchObject({ success: false, invalidate: true });
    expect(() => h.app.commerce.updateProfile("t", { ...h.app.commerce.profile().value, icon: "/brand/../api/v1/health" }, h.app.commerce.profile().revision)).toThrow();
  });

  it("is disabled by default: nothing answers until the Studio switches it on", async () => {
    expect(h.app.commerce.effective().availability).toBe("disabled");
    expect((await fetch(`${h.origin}/api/sileo/v1/info`)).status).toBe(503);
    expect((await fetch(`${h.origin}/api/sileo/v1/authenticate?udid=x&model=y`, { redirect: "manual" })).status).toBe(503);
  });
});

// ---------------------------------------------------------------- Studio and HCG Repo contract

async function studio(c: Client) {
  const r = await c.get("/api/v1/commerce/overview");
  const body = (await r.json()) as Record<string, any>;
  return { status: r.status, body, csrf: body.csrfToken as string | undefined };
}

describe("Payment Provider Studio, developers and the HCG Repo contract", () => {
  async function staff(env: Record<string, string> = {}) {
    await h.stop();
    h = await startHarness({ env: { HCG_STORE_OFFERS_CENTRAL_ID: "store.offers", ...env } });
    (h.authority as TestLedgerAuthority).grant(ALICE.sub, "hcg.store", "feature:store.offers", "test", null);
    return h.signIn(ALICE);
  }

  it("customers cannot read or change commerce settings; staff changes need CSRF and the current revision", async () => {
    const admin = await staff();
    const bob = await h.signIn(BOB);
    expect((await bob.get("/api/v1/commerce/overview")).status).toBe(403);
    const { status, body, csrf } = await studio(admin);
    expect(status).toBe(200);
    expect(body.rights).toMatchObject({ read: true, manage: true });
    expect(body.gates).toMatchObject({ livePayments: false, paymentProvider: "test" });
    const profile = { ...body.profile.value, availability: "internal", paymentMode: "test" };
    const put = (headers: Record<string, string>, revision: number) => admin.request("/api/v1/commerce/provider", { method: "PUT", json: { revision, profile }, headers });
    expect((await put({}, 0)).status).toBe(403); // no CSRF token
    expect((await put({ "x-hcg-csrf": csrf! }, 0)).status).toBe(200);
    expect((await put({ "x-hcg-csrf": csrf! }, 0)).status).toBe(409); // stale revision
    // Gates the Studio cannot override: live payments do not exist.
    const live = await admin.request("/api/v1/commerce/provider", { method: "PUT", json: { revision: 1, profile: { ...profile, paymentMode: "live" } }, headers: { "x-hcg-csrf": csrf! } });
    expect(live.status).toBe(400);
    const audit = (await (await admin.get("/api/v1/commerce/audit")).json()) as { entries: { action: string; actor: string }[] };
    expect(audit.entries[0]).toMatchObject({ action: "provider.profile-updated", actor: ALICE.sub });
  });

  it("the channel follows the catalogue's mapping and the offers; health and preview report the real state", async () => {
    const admin = await staff();
    const { csrf } = await studio(admin);
    const put = (pkg: string, json: Record<string, unknown>) => admin.request(`/api/v1/commerce/channels/${pkg}`, { method: "PUT", json, headers: { "x-hcg-csrf": csrf! } });
    const base = { productId: "fixture-quasar-shell", editionId: "unleashed", status: "active", access: "paid", architectures: ["iphoneos-arm64"], minIos: "15.0", maxIos: null, updatePolicy: "all-updates", repository: FIXTURE_REPO };
    const unmapped = await put("com.example.not.in.catalogue", base);
    expect(unmapped.status).toBe(400);
    expect(await unmapped.text()).toContain("does not list com.example.not.in.catalogue");
    expect((await put(PKG, { ...base, access: "account" })).status).toBe(400); // edition is sold
    expect((await put(PKG, base)).status).toBe(200);
    expect((await put(PKG, base)).status).toBe(409); // revision required for an update

    const health = (await (await admin.get("/api/v1/commerce/provider/health")).json()) as { checks: { id: string; ok: boolean }[] };
    expect(health.checks.find((c) => c.id === "availability")).toMatchObject({ ok: false });
    expect(health.checks.find((c) => c.id === "channels")).toMatchObject({ ok: true });
    expect(health.checks.find((c) => c.id === "info-contract")).toMatchObject({ ok: true });
    const preview = (await (await admin.get(`/api/v1/commerce/provider/preview?package=${PKG}`)).json()) as Record<string, any>;
    expect(preview.info.body.name).toBe("HCG Store");
    expect(preview.packageInfo.body).toEqual({ price: "€9.99", purchased: 0, available: 0 });
  });

  it("HCG Repo: package list and exact-file verification against approved releases", async () => {
    const admin = await staff();
    enableSileoProvider(h);
    const list = (await (await admin.get("/api/v1/repo/packages")).json()) as Record<string, any>;
    expect(list.payment_endpoint).toBe(`${h.origin}/api/sileo/v1/`);
    expect(list.packages[0]).toMatchObject({ package: PKG, access: "paid", commercial: true, versions: [expect.objectContaining({ version: "1.0.0", sha256: sha(FILES["quasar/unleashed-1.0.0-arm64.deb"]) })] });
    const { csrf } = await studio(admin);
    const verify = async (b: Record<string, unknown>) => (await (await admin.request("/api/v1/repo/packages/verify", { method: "POST", json: b, headers: { "x-hcg-csrf": csrf! } })).json()) as { ok: boolean; problems: string[] };
    const good = { package: PKG, version: "1.0.0-1", architecture: "iphoneos-arm64", sha256: sha(FILES["quasar/unleashed-1.0.0-arm64.deb"]), repository: FIXTURE_REPO };
    expect(await verify(good)).toMatchObject({ ok: true, problems: [] });
    expect((await verify({ ...good, sha256: "0".repeat(64) })).problems.join(" ")).toMatch(/SHA-256 mismatch/);
    expect((await verify({ ...good, version: "2.0.0" })).problems.join(" ")).toMatch(/not 2\.0\.0/);
    expect((await verify({ ...good, package: "com.example.orphan" })).problems.join(" ")).toMatch(/orphaned/);
  });

  it("developers: ownership, commission agreements and a sales report from purchase records; payouts never eligible", async () => {
    const admin = await staff();
    enableSileoProvider(h);
    const { csrf } = await studio(admin);
    const H = { "x-hcg-csrf": csrf! };
    expect((await admin.request("/api/v1/commerce/developers/nova-labs", { method: "PUT", json: { displayName: "Nova Labs", status: "active" }, headers: H })).status).toBe(200);
    expect((await admin.request("/api/v1/commerce/ownership/fixture-quasar-shell", { method: "PUT", json: { developerId: "nova-labs" }, headers: H })).status).toBe(200);
    const ag = await admin.request("/api/v1/commerce/agreements", { method: "POST", json: { developerId: "nova-labs", commissionBps: 2000, effectiveFrom: h.clock.t - 1000 }, headers: H });
    expect(ag.status).toBe(201);
    expect((await admin.request("/api/v1/commerce/agreements", { method: "POST", json: { developerId: "nova-labs", commissionBps: 1500, effectiveFrom: h.clock.t }, headers: H })).status).toBe(409);
    const s = new SileoClient();
    await s.signIn(BOB);
    await buyInSileo(s);
    const web = await h.signIn(BOB);
    await buy(web, "fixture-quasar-standard-monthly-test");
    const report = (await (await admin.get(`/api/v1/commerce/sales?from=0&to=${h.clock.t + 1}`)).json()) as { payoutsActive: boolean; rows: Record<string, any>[] };
    expect(report.payoutsActive).toBe(false);
    const nova = report.rows.find((r) => r.developerId === "nova-labs")!;
    expect(nova).toMatchObject({ currency: "EUR", test: true, purchases: 2, gross: 999 + 299, net: 999 + 299, commission: 200 + 60, developerShare: 799 + 239, byChannel: { "package-manager": 1, web: 1 } });
    expect(nova.payout.eligible).toBe(false);
    expect(nova.payout.reasons.join(" ")).toMatch(/not activated/);
  });
});
