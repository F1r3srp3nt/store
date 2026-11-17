/**
 * Checkout and purchase ledger.
 *
 * Rules enforced here:
 * - The browser sends only an offer ID. Product, edition, price and currency come from the
 *   server's offers file.
 * - Entitlements are granted ONLY when a provider event with a valid signature reports a completed
 *   payment whose amount and currency match the checkout. A checkout redirect, a "success" page or
 *   a client-side flag never grants anything.
 * - Every provider event is processed at most once (provider + event ID is a primary key), and a
 *   checkout can produce at most one purchase.
 * - Refunds, chargebacks and subscription expiry revoke the grants that purchase created, and only
 *   those: access from another valid purchase is untouched.
 * - Events may arrive out of order. A refund or dispute that arrives before the completed payment is
 *   remembered, so the late completion records the purchase as refunded and grants nothing. A stale
 *   renewal never shortens access, and a stale expiry never ends a renewed subscription.
 * - Verified purchases reach HCG through the central grant outbox (grants.ts) when it is configured.
 *
 * Only a TEST provider exists. HCG has no approved payment integration yet (see docs/PAYMENTS.md);
 * a live provider must be added and approved before live payments can be enabled.
 */
import { createHmac } from "node:crypto";
import { randomToken, safeEqual } from "./crypto";
import { transaction, type Db } from "./db";
import type { EntitlementAuthority } from "./entitlements";
import type { CentralGrantOutbox, GrantReason } from "./grants";
import { findProduct, type Offer, type Registry } from "./registry";

export type PaymentEventType =
  | "checkout.completed"
  | "checkout.pending"
  | "checkout.failed"
  | "payment.refunded"
  | "payment.disputed"
  | "subscription.renewed"
  | "subscription.canceled"
  | "subscription.expired";

export interface PaymentEvent {
  id: string;
  type: PaymentEventType;
  checkoutId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** Subscriptions: end of the paid period (ms since epoch). */
  periodEnd?: number;
}

export interface CheckoutSession {
  id: string;
  sub: string;
  offerId: string;
  amount: number;
  currency: string;
  status: "open" | "pending" | "completed" | "failed";
}

export type EventOutcome = "processed" | "duplicate" | "ignored" | "rejected";

export class PaymentLedger {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly authority: EntitlementAuthority,
    private readonly now: () => number,
    private readonly outbox: CentralGrantOutbox | null = null,
  ) {}

  /** Whether a verified purchase can be fulfilled: locally (test ledger) or centrally (grant outbox). */
  get canFulfil(): boolean {
    return this.authority.canGrant || !!this.outbox?.enabled;
  }

  createCheckout(sub: string, offer: Offer, provider: string): CheckoutSession {
    const id = `chk_${randomToken(18)}`;
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO checkout_sessions (id, sub, offer_id, amount, currency, status, provider, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(id, sub, offer.id, offer.unitAmount, offer.currency, provider, t, t);
    return this.checkout(id)!;
  }

  checkout(id: string): CheckoutSession | null {
    const r = this.db.prepare(`SELECT id, sub, offer_id, amount, currency, status FROM checkout_sessions WHERE id = ?`).get(id) as
      | { id: string; sub: string; offer_id: string; amount: number; currency: string; status: CheckoutSession["status"] }
      | undefined;
    return r ? { id: r.id, sub: r.sub, offerId: r.offer_id, amount: r.amount, currency: r.currency, status: r.status } : null;
  }

  purchasesFor(sub: string) {
    return this.db
      .prepare(
        `SELECT id, offer_id, amount, currency, kind, status, current_period_end, created_at, updated_at FROM purchases WHERE sub = ? ORDER BY created_at DESC`,
      )
      .all(sub) as {
      id: string;
      offer_id: string;
      amount: number;
      currency: string;
      kind: string;
      status: string;
      current_period_end: number | null;
      created_at: number;
      updated_at: number;
    }[];
  }

  private offer(id: string): Offer | undefined {
    return this.registry.offers.find((o) => o.id === id);
  }

  private grantsFor(offer: Offer) {
    const product = findProduct(this.registry, offer.productId);
    return offer.grants.map((g) => ({
      centralProductId: offer.centralProductId,
      edition: g.edition,
      // The central key for this edition (D2): "*" is the explicit all-editions licence, null a product without editions.
      centralEdition: g.edition === "*" ? "*" : g.edition === "default" ? null : (product?.editions.find((e) => e.id === g.edition)?.centralEditionKey ?? null),
      features: g.features ?? [],
    }));
  }

  private grant(provider: string, sub: string, offer: Offer, purchaseId: string, startsAt: number, periodEnd: number | null) {
    for (const g of this.grantsFor(offer)) {
      if (this.authority.canGrant) this.authority.grant(sub, g.centralProductId, g.edition, purchaseId, periodEnd);
      if (this.outbox?.enabled) this.outbox.setActive(this.outbox.key(provider, purchaseId, g.centralEdition), sub, g.centralProductId, g.centralEdition, startsAt, periodEnd, g.features);
    }
  }

  private revoke(provider: string, sub: string, offer: Offer, purchaseId: string, reason: GrantReason) {
    for (const g of this.grantsFor(offer)) {
      if (this.authority.canGrant) this.authority.revoke(sub, g.centralProductId, g.edition, purchaseId);
      if (this.outbox?.enabled) this.outbox.setRevoked(this.outbox.key(provider, purchaseId, g.centralEdition), reason);
    }
  }

  /** Apply one verified provider event. Must only be called after the signature has been verified. */
  apply(provider: string, e: PaymentEvent): EventOutcome {
    return transaction(this.db, () => {
      const t = this.now();
      const inserted = this.db
        .prepare(`INSERT OR IGNORE INTO payment_events (provider, event_id, type, received_at, outcome) VALUES (?, ?, ?, ?, 'pending')`)
        .run(provider, e.id, e.type, t);
      if (inserted.changes === 0) return "duplicate";
      const outcome = this.applyNew(provider, e, t);
      this.db.prepare(`UPDATE payment_events SET outcome = ? WHERE provider = ? AND event_id = ?`).run(outcome, provider, e.id);
      return outcome;
    });
  }

  private applyNew(provider: string, e: PaymentEvent, t: number): EventOutcome {
    const chk = this.checkout(e.checkoutId);
    if (!chk) return "rejected";
    const offer = this.offer(chk.offerId);
    if (!offer) return "rejected";
    // The amount and currency must be exactly what the server priced; anything else is not this purchase.
    if (e.amount !== chk.amount || e.currency !== chk.currency) return "rejected";

    const setCheckout = (status: CheckoutSession["status"]) =>
      this.db.prepare(`UPDATE checkout_sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, t, chk.id);
    const purchase = this.db.prepare(`SELECT id, status, current_period_end FROM purchases WHERE checkout_id = ?`).get(chk.id) as
      | { id: string; status: string; current_period_end: number | null }
      | undefined;

    switch (e.type) {
      case "checkout.pending":
        if (chk.status === "open") setCheckout("pending");
        return "processed";
      case "checkout.failed":
        if (chk.status === "completed") return "ignored";
        setCheckout("failed");
        return "processed";
      case "checkout.completed": {
        if (purchase) return "ignored";
        if (chk.status === "failed") return "rejected";
        const id = `pur_${randomToken(18)}`;
        const periodEnd = offer.kind === "subscription" ? (e.periodEnd ?? null) : null;
        if (offer.kind === "subscription" && !periodEnd) return "rejected";
        // A refund or dispute already arrived for this checkout: record the purchase, grant nothing.
        const reversal = this.db.prepare(`SELECT type FROM checkout_reversals WHERE checkout_id = ?`).get(chk.id) as { type: string } | undefined;
        const status = reversal ? (reversal.type === "payment.refunded" ? "refunded" : "disputed") : offer.kind === "subscription" ? "active" : "paid";
        this.db
          .prepare(
            `INSERT INTO purchases (id, sub, offer_id, checkout_id, provider, provider_payment_id, amount, currency, kind, status, current_period_end, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, chk.sub, offer.id, chk.id, provider, e.paymentId, e.amount, e.currency, offer.kind, status, periodEnd, t, t);
        setCheckout("completed");
        if (!reversal) this.grant(provider, chk.sub, offer, id, t, periodEnd);
        return "processed";
      }
      case "payment.refunded":
      case "payment.disputed": {
        if (!purchase) {
          // Out of order: remember it, so a late "checkout.completed" cannot grant access.
          this.db.prepare(`INSERT OR IGNORE INTO checkout_reversals (checkout_id, type, received_at) VALUES (?, ?, ?)`).run(chk.id, e.type, t);
          return "processed";
        }
        this.db.prepare(`UPDATE purchases SET status = ?, updated_at = ? WHERE id = ?`).run(e.type === "payment.refunded" ? "refunded" : "disputed", t, purchase.id);
        this.revoke(provider, chk.sub, offer, purchase.id, e.type === "payment.refunded" ? "refund" : "chargeback");
        return "processed";
      }
      case "subscription.renewed": {
        if (!purchase || offer.kind !== "subscription" || !e.periodEnd) return "ignored";
        if (purchase.status === "refunded" || purchase.status === "disputed") return "ignored";
        // A stale renewal (delivered late) never shortens or re-extends to an older period.
        if (purchase.current_period_end !== null && e.periodEnd <= purchase.current_period_end) return "ignored";
        this.db.prepare(`UPDATE purchases SET status = 'active', current_period_end = ?, updated_at = ? WHERE id = ?`).run(e.periodEnd, t, purchase.id);
        this.grant(provider, chk.sub, offer, purchase.id, t, e.periodEnd);
        return "processed";
      }
      case "subscription.canceled": {
        // Access continues until the end of the period already paid for; it is not renewed.
        if (!purchase || offer.kind !== "subscription") return "ignored";
        this.db.prepare(`UPDATE purchases SET status = 'canceled', updated_at = ? WHERE id = ?`).run(t, purchase.id);
        return "processed";
      }
      case "subscription.expired": {
        if (!purchase || offer.kind !== "subscription") return "ignored";
        // A stale expiry (for a period that has since been renewed) must not end access.
        const end = purchase.current_period_end;
        if (end !== null && (e.periodEnd !== undefined ? e.periodEnd < end : t < end)) return "ignored";
        this.db.prepare(`UPDATE purchases SET status = 'expired', updated_at = ? WHERE id = ?`).run(t, purchase.id);
        this.revoke(provider, chk.sub, offer, purchase.id, "subscription_ended");
        return "processed";
      }
    }
  }
}

/**
 * TEST payment provider. It simulates a hosted checkout page and sends signed webhook events using
 * the same scheme real providers use (timestamped HMAC-SHA256 over the raw body). It never moves
 * money and can only be enabled in test mode.
 */
export const TEST_SIGNATURE_HEADER = "hcg-test-signature";
const TOLERANCE_MS = 5 * 60 * 1000;

export function signTestEvent(secret: string, rawBody: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export function verifyTestEvent(secret: string, rawBody: string, header: string | undefined, now: number): PaymentEvent | null {
  if (!header) return null;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1 || Math.abs(now - ts) > TOLERANCE_MS) return null;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  if (!safeEqual(parts.v1, expected)) return null;
  try {
    const e = JSON.parse(rawBody) as PaymentEvent;
    const types: PaymentEventType[] = [
      "checkout.completed",
      "checkout.pending",
      "checkout.failed",
      "payment.refunded",
      "payment.disputed",
      "subscription.renewed",
      "subscription.canceled",
      "subscription.expired",
    ];
    if (typeof e.id !== "string" || !types.includes(e.type) || typeof e.checkoutId !== "string" || typeof e.paymentId !== "string") return null;
    if (!Number.isInteger(e.amount) || typeof e.currency !== "string") return null;
    return e;
  } catch {
    return null;
  }
}
