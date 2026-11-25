/**
 * HCG Payments provider (TEST MODE ONLY).
 *
 * With HCG_STORE_PAYMENT_PROVIDER=hcg-payments the Store does not keep payments itself:
 * - checkout asks HCG Payments (server to server, signed) to open a provider-hosted checkout for the
 *   signed-in person's HCG `sub`, and redirects the browser there;
 * - HCG Payments verifies the provider's signed events and asks HCG's licensing to grant or revoke;
 * - ownership is still decided only by HCG's licensing (/check), exactly as for every other purchase source.
 * The Store keeps only the link between its checkout attempt and the HCG Payments order (hcg_payments_checkouts).
 * Payment status is shown on the return page and in the account; it never decides access.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { HcgPaymentsSettings } from "./config";
import type { Db } from "./db";

export interface PaymentsOrder {
  id: string;
  status: string;
  fulfilment: string;
  amount: number;
  currency: string;
  product_id: string;
  price_id: string;
  customer: { sub: string };
  checkout: { id: string; url: string | null; status: string; expires_at: string } | null;
  amounts?: { captured: number; refunded: number };
  created_at: string;
}

export class HcgPaymentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class HcgPaymentsClient {
  constructor(
    private readonly s: HcgPaymentsSettings,
    private readonly db: Db,
    private readonly now: () => number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(18).toString("base64url");
    const toSign = `${ts}\n${nonce}\n${method}\n${path}\n${createHash("sha256").update(raw).digest("hex")}\n`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.s.url + path, {
        method,
        headers: {
          accept: "application/json",
          ...(raw ? { "content-type": "application/json" } : {}),
          "x-hcg-client": this.s.clientId,
          "x-hcg-timestamp": ts,
          "x-hcg-nonce": nonce,
          "x-hcg-signature": createHmac("sha256", this.s.secret).update(toSign).digest("hex"),
          ...headers,
        },
        body: raw || undefined,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HcgPaymentsError(503, "payments_unreachable", "HCG Payments could not be reached.");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const e = (json.error ?? {}) as Record<string, unknown>;
      throw new HcgPaymentsError(res.status, String(e.code ?? "error"), String(e.message ?? `HTTP ${res.status}`), e);
    }
    return json as T;
  }

  /** Start (or resume) a checkout. The Store attempt ID is the idempotency key, so a retry never opens a second one. */
  async startCheckout(args: { sub: string; offerId: string; productId: string; priceId: string; successUrl: (chk: string) => string; cancelUrl: string }) {
    const chk = `chk_${randomBytes(18).toString("base64url")}`;
    this.db.prepare(`INSERT INTO hcg_payments_checkouts (id, sub, offer_id, order_id, created_at) VALUES (?, ?, ?, NULL, ?)`).run(chk, args.sub, args.offerId, this.now());
    let order: PaymentsOrder;
    try {
      order = await this.request<PaymentsOrder>(
        "POST",
        "/v1/checkout-sessions",
        { product_id: args.productId, price_id: args.priceId, customer: { sub: args.sub }, success_url: args.successUrl(chk), cancel_url: args.cancelUrl },
        { "idempotency-key": `store-${chk}` },
      );
    } catch (e) {
      // An open checkout already exists for this person and product: send them back to it.
      if (e instanceof HcgPaymentsError && e.code === "checkout_in_progress" && typeof e.details.order_id === "string") {
        order = await this.order(e.details.order_id);
        if (order.customer.sub !== args.sub || !order.checkout?.url) throw e;
      } else throw e;
    }
    this.db.prepare(`UPDATE hcg_payments_checkouts SET order_id = ? WHERE id = ?`).run(order.id, chk);
    return { checkoutId: chk, order };
  }

  attempt(id: string) {
    return (this.db.prepare(`SELECT id, sub, offer_id, order_id FROM hcg_payments_checkouts WHERE id = ?`).get(id) as { id: string; sub: string; offer_id: string; order_id: string | null } | undefined) ?? null;
  }

  order(orderId: string) {
    return this.request<PaymentsOrder>("GET", `/v1/orders/${encodeURIComponent(orderId)}`);
  }

  async billingHistory(sub: string) {
    const r = await this.request<{ data: { order_id: string; product_id: string; status: string; amount: number; currency: string; refunded: number; mode: string; created_at: string }[] }>(
      "GET",
      `/v1/customers/${encodeURIComponent(sub)}/billing-history`,
    );
    return r.data;
  }
}

/** HCG Payments order status → the Store return page's states. Display only. */
export function returnStatus(o: PaymentsOrder): "open" | "pending" | "completed" | "failed" | "cancelled" | "refunded" {
  if (["paid", "partially_refunded", "active", "past_due"].includes(o.status)) return "completed";
  if (o.status === "pending") return "pending";
  if (o.status === "expired") return "cancelled";
  if (o.status === "refunded" || o.status === "disputed") return "refunded";
  if (o.status === "failed") return "failed";
  return "open";
}
