// @vitest-environment node
/**
 * HCG Payments provider (TEST MODE ONLY): the Store asks HCG Payments for a provider-hosted checkout,
 * shows recorded status, and never decides ownership from payment state (HCG's /check does).
 * HCG Payments itself is stubbed here; the full journey against the real HCG Payments server runs in
 * the HCG-Payments repository (testenv).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStoreConfig } from "../src/config";
import { startHarness, TEST_OFFERS, type Harness } from "./harness";

const ALICE = { sub: "user-alice", email: "alice@example.test", name: "Alice" };
const SECRET = "store-payments-client-secret-0123456789";

const offersFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "hcg-store-pay-"));
  const offers = TEST_OFFERS.offers.map((o) => ({ ...o, payments: { productId: `pay-${o.id}`, priceId: `price_${o.id.replace(/-/g, "_")}` } }));
  writeFileSync(join(dir, "offers.json"), JSON.stringify({ offers }));
  return { file: join(dir, "offers.json"), offers };
};

/** Ecosystem stub: the person belongs to no organisation, so owns nothing. */
const noOrgs: typeof fetch = async (input, init) => {
  const u = String(input);
  // Answer as the token's own subject, as HCG's /me does.
  const token = new Headers(init?.headers).get("authorization")?.split(".")[1] ?? "";
  const sub = (JSON.parse(Buffer.from(token, "base64url").toString() || "{}") as { sub?: string }).sub ?? ALICE.sub;
  if (u.endsWith("/me")) return Response.json({ api_version: "v1", user: { id: sub }, organisations: [] });
  return Response.json({ api_version: "v1", items: [] });
};

function paymentsStub(opts: { amount?: number; orderStatus?: string; fulfilment?: string } = {}) {
  const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", path: u.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const order = {
      id: "ord_test1",
      status: opts.orderStatus ?? "open",
      fulfilment: opts.fulfilment ?? "none",
      amount: opts.amount ?? 999,
      currency: "eur",
      product_id: "pay-fixture-quasar-unleashed-test",
      price_id: "x",
      customer: { sub: ALICE.sub },
      checkout: { id: "cs_1", url: "https://checkout.stripe.test/c/pay/cs_test_1", status: "open", expires_at: "2026-11-15T12:30:00Z" },
      created_at: "2026-11-15T12:00:00Z",
    };
    if (u.pathname === "/v1/checkout-sessions") return Response.json(order, { status: 201 });
    if (u.pathname.startsWith("/v1/orders/")) return Response.json(order);
    if (u.pathname.endsWith("/billing-history"))
      return Response.json({ data: [{ order_id: "ord_test1", product_id: order.product_id, status: order.status, amount: order.amount, currency: "eur", refunded: 0, mode: "test", created_at: order.created_at }] });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  return { calls, fetchImpl };
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

async function start(stub: ReturnType<typeof paymentsStub>) {
  const o = offersFile();
  h = await startHarness({
    authority: "hcg-ecosystem",
    ecosystemFetch: noOrgs,
    paymentsFetch: stub.fetchImpl,
    env: {
      HCG_STORE_PAYMENT_PROVIDER: "hcg-payments",
      HCG_STORE_PAYMENTS_URL: "http://127.0.0.1:8790",
      HCG_STORE_PAYMENTS_CLIENT_ID: "hcg-store",
      HCG_STORE_PAYMENTS_CLIENT_SECRET: SECRET,
      HCG_STORE_OFFERS_FILE: o.file,
    },
  });
  return h;
}

describe("HCG Payments provider: configuration", () => {
  const base = { HCG_STORE_PAYMENT_PROVIDER: "hcg-payments", HCG_STORE_PAYMENTS_URL: "http://127.0.0.1:8790", HCG_STORE_PAYMENTS_CLIENT_ID: "hcg-store", HCG_STORE_PAYMENTS_CLIENT_SECRET: SECRET };
  it("is refused outside test mode (no live payments without the founder's approval)", () => {
    expect(() => parseStoreConfig({ ...base, HCG_STORE_MODE: "production", HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test", HCG_STORE_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") })).toThrow(/test mode/);
  });
  it("requires central entitlement checks and a valid client secret", () => {
    expect(() => parseStoreConfig({ ...base, HCG_STORE_MODE: "test", HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger" })).toThrow(/licensed centrally/);
    expect(() =>
      parseStoreConfig({ ...base, HCG_STORE_MODE: "test", HCG_STORE_ENTITLEMENT_AUTHORITY: "hcg-ecosystem", HCG_ECOSYSTEM_API_URL: "http://127.0.0.1:9/x", HCG_STORE_PAYMENTS_CLIENT_SECRET: "short" }),
    ).toThrow(/CLIENT_SECRET is missing or not valid/);
  });
  it("never repeats the client secret in an error", () => {
    try {
      parseStoreConfig({ ...base, HCG_STORE_MODE: "production" });
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });
});

describe("HCG Payments provider: checkout", () => {
  it("opens the provider-hosted checkout through a signed, idempotent server call for the signed-in person", async () => {
    const stub = paymentsStub();
    const s = await start(stub);
    const offers = (await (await s.anonymous().get("/api/v1/offers")).json()) as { checkoutAvailable: boolean; testMode: boolean };
    expect(offers).toMatchObject({ checkoutAvailable: true, testMode: true });
    const alice = await s.signIn(ALICE);
    const r = await alice.post("/api/v1/checkout", { offerId: "fixture-quasar-unleashed-test" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { checkoutId: string; redirectUrl: string };
    expect(body.redirectUrl).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    const call = stub.calls.find((c) => c.path === "/v1/checkout-sessions")!;
    expect(call.body).toMatchObject({ product_id: "pay-fixture-quasar-unleashed-test", customer: { sub: ALICE.sub } });
    expect(call.headers.get("idempotency-key")).toBe(`store-${body.checkoutId}`);
    expect(call.headers.get("x-hcg-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(SECRET);

    // The return page shows only what HCG Payments recorded; arriving there grants nothing.
    const st = (await (await alice.get(`/api/v1/checkout/${body.checkoutId}`)).json()) as { status: string };
    expect(st.status).toBe("open");
    const access = (await (await alice.get("/api/v1/products/fixture-quasar-shell/access?edition=unleashed")).json()) as { editions: { owned: boolean }[] };
    expect(access.editions[0]!.owned).toBe(false);
  });

  it("refuses a checkout whose price differs from the Store's offer", async () => {
    const s = await start(paymentsStub({ amount: 1 }));
    const alice = await s.signIn(ALICE);
    const r = await alice.post("/api/v1/checkout", { offerId: "fixture-quasar-unleashed-test" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("price_mismatch");
  });

  it("reports a paid order as 'granting' until HCG's licensing records it, and lists the purchase", async () => {
    const s = await start(paymentsStub({ orderStatus: "paid", fulfilment: "pending" }));
    const alice = await s.signIn(ALICE);
    const { checkoutId } = (await (await alice.post("/api/v1/checkout", { offerId: "fixture-quasar-unleashed-test" })).json()) as { checkoutId: string };
    expect(await (await alice.get(`/api/v1/checkout/${checkoutId}`)).json()).toMatchObject({ status: "completed", fulfilment: "pending" });
    const lib = (await (await alice.get("/api/v1/library")).json()) as { purchases: { status: string; amount: number }[] };
    expect(lib.purchases).toEqual([expect.objectContaining({ status: "paid", amount: 999 })]);
  });

  it("does not let another person read someone's checkout", async () => {
    const s = await start(paymentsStub());
    const alice = await s.signIn(ALICE);
    const { checkoutId } = (await (await alice.post("/api/v1/checkout", { offerId: "fixture-quasar-unleashed-test" })).json()) as { checkoutId: string };
    const bob = await s.signIn({ sub: "user-bob", email: "bob@example.test" });
    expect((await bob.get(`/api/v1/checkout/${checkoutId}`)).status).toBe(404);
  });
});
