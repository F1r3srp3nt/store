// @vitest-environment node
/**
 * Decision D5 on the Store side: verified purchases reach HCG through the central grant outbox, and
 * payment events are safe when duplicated or delivered out of order. The mock below implements the
 * PROPOSED central contract (docs/MAIN-SITE-HANDOFF-REQUEST.md): revision-ordered, revoke terminal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseStoreConfig } from "../src/config";
import type { PaymentEvent } from "../src/payments";
import { buildRegistry, type Offer } from "../src/registry";
import { validateCatalogue } from "../../src/domain/catalogue";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CATALOGUE, startHarness, TEST_OFFERS, type Harness } from "./harness";

const CREDENTIAL = "test-credential-0123456789abcdefghijklmnop";
const GRANT_URL = "https://hcg.test/api/public/store/v1/entitlements";
const SUB = "sub-alice";

/** The proposed central service: one record per purchase_id, newest revision wins, revoked is terminal. */
function mockCentral() {
  const records = new Map<string, { status: "active" | "revoked"; revision: number; body: Record<string, unknown> }>();
  const requests: { auth: string | null; body: Record<string, unknown> }[] = [];
  let failNext = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ auth, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (failNext > 0) {
      failNext -= 1;
      return json(503, { error: { code: "unavailable", message: "x" } });
    }
    if (auth !== `HCG-Store-Server ${CREDENTIAL}`) return json(401, { error: { code: "credential_refused", message: "x" } });
    if (body.environment !== "test") return json(400, { error: { code: "environment_mismatch", message: "x" } });
    const id = String(body.purchase_id);
    const rev = Number(body.revision);
    const cur = records.get(id);
    if (body.action === "revoke") {
      // A revoke for a purchase not seen yet is kept as a tombstone, so a late grant cannot activate it.
      if (cur?.status === "revoked") return json(409, { error: { code: "already_revoked", message: "x" } });
      records.set(id, { status: "revoked", revision: Math.max(rev, cur?.revision ?? 0), body });
    } else if (!cur) records.set(id, { status: "active", revision: rev, body });
    else if (cur.status === "active" && rev > cur.revision) records.set(id, { status: "active", revision: rev, body });
    // a delayed or duplicate grant never changes a newer or revoked record
    const r = records.get(id)!;
    return json(200, { purchase_id: id, status: r.status, revision: r.revision, replayed: r.body !== body });
  }) as typeof fetch;
  return { fetchImpl, records, requests, failNext: (n: number) => (failNext = n) };
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

async function setup(central = mockCentral()) {
  h = await startHarness({ env: { HCG_STORE_GRANT_API_URL: GRANT_URL, HCG_STORE_GRANT_CREDENTIAL: CREDENTIAL }, grantFetch: central.fetchImpl });
  const offer = (id: string) => h!.app.deps.registry.offers.find((o) => o.id === id)!;
  let n = 0;
  const event = (type: PaymentEvent["type"], checkoutId: string, extra: Partial<PaymentEvent> = {}): PaymentEvent => {
    const chk = h!.app.ledger.checkout(checkoutId)!;
    return { id: `evt_${++n}`, type, checkoutId, paymentId: `pay_${checkoutId}`, amount: chk.amount, currency: chk.currency, ...extra };
  };
  const owns = async (edition: string) =>
    (await h!.authority.check({ sub: SUB, accessToken: null }, { centralProductId: "fixture.quasar.shell", editionId: edition, centralEditionKey: edition })).status;
  return { h: h!, central, offer, event, owns };
}

describe("central grant outbox (D5, Store side)", () => {
  it("reports a verified purchase with a namespaced ID, the bound environment and the edition's central key", async () => {
    const { h, central, offer, event } = await setup();
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    expect(h.app.ledger.apply("test", event("checkout.completed", chk.id))).toBe("processed");
    await h.outbox.deliver();
    expect(central.requests).toHaveLength(1);
    const req = central.requests[0]!;
    expect(req.auth).toBe(`HCG-Store-Server ${CREDENTIAL}`);
    expect(req.body).toMatchObject({ action: "grant", sub: SUB, product_id: "fixture.quasar.shell", edition: "unleashed", environment: "test", revision: 1, ends_at: null });
    expect(String(req.body.purchase_id)).toMatch(/^store:test:test:pur_[A-Za-z0-9_-]+:unleashed$/);
    expect(h.outbox.pending()).toBe(0);
  });

  it("duplicate events and repeated deliveries change nothing", async () => {
    const { h, central, offer, event } = await setup();
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    const e = event("checkout.completed", chk.id);
    expect(h.app.ledger.apply("test", e)).toBe("processed");
    expect(h.app.ledger.apply("test", e)).toBe("duplicate");
    expect(h.app.ledger.apply("test", { ...e, id: "evt_other" })).toBe("ignored");
    await h.outbox.deliver();
    await h.outbox.deliver();
    expect(central.requests).toHaveLength(1);
    expect(h.app.ledger.purchasesFor(SUB)).toHaveLength(1);
  });

  it("a refund revokes that purchase centrally; revoked is terminal", async () => {
    const { h, central, offer, event, owns } = await setup();
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    h.app.ledger.apply("test", event("checkout.completed", chk.id));
    await h.outbox.deliver();
    h.app.ledger.apply("test", event("payment.refunded", chk.id));
    await h.outbox.deliver();
    const [rec] = [...central.records.values()];
    expect(rec).toMatchObject({ status: "revoked", revision: 2 });
    expect(central.requests.at(-1)!.body).toMatchObject({ action: "revoke", reason: "refund", revision: 2 });
    expect(await owns("unleashed")).toBe("not-granted");
    // A delayed re-grant for the same purchase (e.g. a replayed completion) cannot reactivate it.
    const key = String(central.requests[0]!.body.purchase_id);
    h.outbox.setActive(key, SUB, "fixture.quasar.shell", "unleashed", 0, null);
    expect(h.outbox.pending()).toBe(0);
  });

  it("out of order: a refund before the completed payment means the purchase never grants access", async () => {
    const { h, central, offer, event, owns } = await setup();
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    expect(h.app.ledger.apply("test", event("payment.refunded", chk.id))).toBe("processed");
    expect(h.app.ledger.apply("test", event("checkout.completed", chk.id))).toBe("processed");
    expect(h.app.ledger.purchasesFor(SUB)[0]!.status).toBe("refunded");
    expect(await owns("unleashed")).toBe("not-granted");
    await h.outbox.deliver();
    expect(central.requests).toHaveLength(0);
  });

  it("revoking one purchase leaves access from another valid purchase", async () => {
    const { h, central, offer, event, owns } = await setup();
    const first = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    const second = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    h.app.ledger.apply("test", event("checkout.completed", first.id));
    h.app.ledger.apply("test", event("checkout.completed", second.id));
    h.app.ledger.apply("test", event("payment.refunded", first.id));
    await h.outbox.deliver();
    expect(await owns("unleashed")).toBe("granted");
    expect([...central.records.values()].map((r) => r.status).sort()).toEqual(["active", "revoked"]);
  });

  it("subscriptions: stale renewals and stale expiries are ignored; a real expiry revokes", async () => {
    const { h, central, offer, event, owns } = await setup();
    const day = 24 * 3600 * 1000;
    const t0 = h.clock.now();
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-standard-monthly-test"), "test");
    h.app.ledger.apply("test", event("checkout.completed", chk.id, { periodEnd: t0 + 30 * day }));
    expect(h.app.ledger.apply("test", event("subscription.renewed", chk.id, { periodEnd: t0 + 60 * day }))).toBe("processed");
    // An older renewal delivered late does not shorten the period.
    expect(h.app.ledger.apply("test", event("subscription.renewed", chk.id, { periodEnd: t0 + 30 * day }))).toBe("ignored");
    // An expiry for the old period, delivered after the renewal, does not end access.
    expect(h.app.ledger.apply("test", event("subscription.expired", chk.id, { periodEnd: t0 + 30 * day }))).toBe("ignored");
    expect(await owns("standard")).toBe("granted");
    await h.outbox.deliver();
    expect([...central.records.values()][0]).toMatchObject({ status: "active", revision: 2 });
    expect(central.requests.at(-1)!.body.ends_at).toBe(new Date(t0 + 60 * day).toISOString());
    // The real expiry of the current period revokes.
    expect(h.app.ledger.apply("test", event("subscription.expired", chk.id, { periodEnd: t0 + 60 * day }))).toBe("processed");
    await h.outbox.deliver();
    expect([...central.records.values()][0]).toMatchObject({ status: "revoked" });
    expect(central.requests.at(-1)!.body).toMatchObject({ action: "revoke", reason: "subscription_ended" });
  });

  it("failures are retried with backoff; the credential never reaches the database or an error", async () => {
    const central = mockCentral();
    central.failNext(1);
    const { h, offer, event } = await setup(central);
    const chk = h.app.ledger.createCheckout(SUB, offer("fixture-quasar-unleashed-test"), "test");
    h.app.ledger.apply("test", event("checkout.completed", chk.id));
    expect(await h.outbox.deliver()).toEqual({ delivered: 0, failed: 1 });
    // Every stored outbox column, including the recorded error, is free of the credential.
    const dump = JSON.stringify(h.db.prepare("SELECT * FROM central_grants").all());
    expect(dump).toContain("HTTP 503");
    expect(dump).not.toContain(CREDENTIAL);
    expect(await h.outbox.deliver()).toEqual({ delivered: 0, failed: 0 }); // backing off
    h.clock.advance(60);
    expect(await h.outbox.deliver()).toEqual({ delivered: 1, failed: 0 });
  });
});

describe("grant configuration (D5)", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const base = { HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test", HCG_STORE_SECRET_KEY: KEY };

  it("binds the environment to the server's mode; nothing in a request can change it", () => {
    const prod = parseStoreConfig({ ...base, HCG_STORE_GRANT_API_URL: GRANT_URL, HCG_STORE_GRANT_CREDENTIAL: CREDENTIAL });
    expect(prod.grants?.environment).toBe("production");
    const test = parseStoreConfig({ ...base, HCG_STORE_MODE: "test", HCG_STORE_GRANT_API_URL: GRANT_URL, HCG_STORE_GRANT_CREDENTIAL: CREDENTIAL });
    expect(test.grants?.environment).toBe("test");
  });

  it("refuses partial or malformed settings without echoing the credential", () => {
    expect(() => parseStoreConfig({ ...base, HCG_STORE_GRANT_API_URL: GRANT_URL })).toThrow(/set together/);
    expect(() => parseStoreConfig({ ...base, HCG_STORE_GRANT_CREDENTIAL: CREDENTIAL })).toThrow(/set together/);
    try {
      parseStoreConfig({ ...base, HCG_STORE_GRANT_API_URL: GRANT_URL, HCG_STORE_GRANT_CREDENTIAL: "short secret" });
      throw new Error("accepted");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String((e as Error).message)).not.toContain("short secret");
    }
    expect(() => parseStoreConfig({ ...base, HCG_STORE_GRANT_API_URL: "http://hcg.test/x", HCG_STORE_GRANT_CREDENTIAL: CREDENTIAL })).toThrow();
  });

  it("refuses an offer that grants an edition without a central edition key (D2)", () => {
    const products = JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "products.json"), "utf8")) as { products: { id: string; editions: { id: string; centralEditionKey: string | null }[] }[] };
    for (const e of products.products.find((p) => p.id === "fixture-quasar-shell")!.editions) e.centralEditionKey = null;
    const cat = validateCatalogue(products, JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "releases.json"), "utf8")));
    expect(cat.ok).toBe(true);
    if (!cat.ok) return;
    expect(() => buildRegistry(cat.catalogue, TEST_OFFERS.offers as Offer[], [], true)).toThrow(/no central edition key/);
  });
});
