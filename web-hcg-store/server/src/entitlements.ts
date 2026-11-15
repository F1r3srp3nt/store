/**
 * Entitlements are owned by HCG, not by the Store. The Store asks an authority whether a person
 * (an HCG Connect subject) holds an active entitlement for a central product edition.
 *
 * - "hcg-ecosystem": HCG's central ecosystem API. Read-only from the Store. HCG has not published a
 *   grant endpoint yet, so purchases cannot be fulfilled against it (canGrant = false), and checkout
 *   stays unavailable with this authority.
 * - "test-ledger": a local stand-in used ONLY in test mode, so the purchase flow can be tested end to
 *   end. It refuses to run in production (see config.ts).
 *
 * Roles are never consulted: an HCG role does not imply ownership of any product.
 */
import type { Db } from "./db";
import { editionKey } from "./registry";

export type CheckResult =
  | { status: "granted"; expiresAt: number | null }
  | { status: "not-granted" }
  | { status: "unavailable"; reason: string };

export interface OwnedItem {
  centralProductId: string;
  edition: string;
  expiresAt: number | null;
}

export interface Subject {
  sub: string;
  /** Current HCG Connect access token (needed by the central API). Never logged. */
  accessToken: string | null;
}

export interface EntitlementAuthority {
  readonly kind: "none" | "test-ledger" | "hcg-ecosystem";
  /** Whether verified purchases can be turned into entitlements. */
  readonly canGrant: boolean;
  check(subject: Subject, centralProductId: string, editionId: string | null): Promise<CheckResult>;
  list(subject: Subject): Promise<{ status: "ok"; items: OwnedItem[] } | { status: "unavailable"; reason: string }>;
  /** Synchronous, so it can run inside the payment-event transaction (test ledger only). */
  grant(sub: string, centralProductId: string, edition: string, source: string, expiresAt: number | null): void;
  revoke(sub: string, centralProductId: string, edition: string, source: string): void;
}

const UNSUPPORTED = "HCG has not published an entitlement grant API. Purchases cannot be fulfilled.";

export class NoAuthority implements EntitlementAuthority {
  readonly kind = "none" as const;
  readonly canGrant = false;
  async check(): Promise<CheckResult> {
    return { status: "unavailable", reason: "No entitlement authority is configured." };
  }
  async list() {
    return { status: "unavailable" as const, reason: "No entitlement authority is configured." };
  }
  grant(): void {
    throw new Error(UNSUPPORTED);
  }
  revoke(): void {
    throw new Error(UNSUPPORTED);
  }
}

/** TEST MODE ONLY. Local stand-in for HCG's entitlement records. */
export class TestLedgerAuthority implements EntitlementAuthority {
  readonly kind = "test-ledger" as const;
  readonly canGrant = true;
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async check(subject: Subject, centralProductId: string, editionId: string | null): Promise<CheckResult> {
    const rows = this.db
      .prepare(
        `SELECT expires_at FROM test_entitlements
         WHERE sub = ? AND product_id = ? AND (edition = ? OR edition = '*') AND status = 'active'`,
      )
      .all(subject.sub, centralProductId, editionKey(editionId)) as { expires_at: number | null }[];
    const valid = rows.filter((r) => r.expires_at === null || r.expires_at > this.now());
    if (!valid.length) return { status: "not-granted" };
    const expiresAt = valid.some((r) => r.expires_at === null) ? null : Math.max(...valid.map((r) => r.expires_at!));
    return { status: "granted", expiresAt };
  }

  async list(subject: Subject) {
    const rows = this.db
      .prepare(`SELECT product_id, edition, expires_at FROM test_entitlements WHERE sub = ? AND status = 'active'`)
      .all(subject.sub) as { product_id: string; edition: string; expires_at: number | null }[];
    const items = rows
      .filter((r) => r.expires_at === null || r.expires_at > this.now())
      .map((r) => ({ centralProductId: r.product_id, edition: r.edition, expiresAt: r.expires_at }));
    return { status: "ok" as const, items };
  }

  grant(sub: string, centralProductId: string, edition: string, source: string, expiresAt: number | null): void {
    this.db
      .prepare(
        `INSERT INTO test_entitlements (sub, product_id, edition, source, status, expires_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (sub, product_id, edition, source) DO UPDATE SET status = 'active', expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(sub, centralProductId, edition, source, expiresAt, this.now());
  }

  revoke(sub: string, centralProductId: string, edition: string, source: string): void {
    this.db
      .prepare(`UPDATE test_entitlements SET status = 'revoked', updated_at = ? WHERE sub = ? AND product_id = ? AND edition = ? AND source = ?`)
      .run(this.now(), sub, centralProductId, edition, source);
  }

  /** Test helper: revoke everything for a subject (simulates an HCG administrator revoking access). */
  revokeAll(sub: string): void {
    this.db.prepare(`UPDATE test_entitlements SET status = 'revoked', updated_at = ? WHERE sub = ?`).run(this.now(), sub);
  }
}

/**
 * HCG ecosystem API (read-only). Contract PROPOSED in docs/HCG-INTEGRATION.md, modelled on the routes
 * HCG already serves (`/me`, `/features`, `/check`); response bodies still need HCG's confirmation.
 * Any unexpected answer is reported as "unavailable", never as a grant.
 */
export class HcgEcosystemAuthority implements EntitlementAuthority {
  readonly kind = "hcg-ecosystem" as const;
  readonly canGrant = false;
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(subject: Subject, centralProductId: string, editionId: string | null): Promise<CheckResult> {
    if (!subject.accessToken) return { status: "unavailable", reason: "No HCG access token." };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${subject.accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ product_id: centralProductId, edition: editionKey(editionId), feature_key: "download" }),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (res.status === 401 || res.status === 403) return { status: "not-granted" };
      if (!res.ok) return { status: "unavailable", reason: `HCG answered ${res.status}.` };
      const body = (await res.json()) as { allowed?: unknown; licence?: { ends_at?: unknown } };
      if (body.allowed === true) {
        const ends = typeof body.licence?.ends_at === "string" ? Date.parse(body.licence.ends_at) : NaN;
        return { status: "granted", expiresAt: Number.isFinite(ends) ? ends : null };
      }
      if (body.allowed === false) return { status: "not-granted" };
      return { status: "unavailable", reason: "HCG's answer did not contain an access decision." };
    } catch {
      return { status: "unavailable", reason: "HCG could not be reached." };
    }
  }

  async list() {
    return { status: "unavailable" as const, reason: "HCG has not published an endpoint that lists owned products." };
  }
  grant(): void {
    throw new Error(UNSUPPORTED);
  }
  revoke(): void {
    throw new Error(UNSUPPORTED);
  }
}
