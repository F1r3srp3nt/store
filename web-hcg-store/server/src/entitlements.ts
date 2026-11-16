/**
 * Entitlements are owned by HCG, not by the Store. The Store asks an authority whether a person
 * (an HCG Connect subject) holds an active entitlement for a central product edition.
 *
 * - "hcg-ecosystem": HCG's central Ecosystem API (`/me`, `/check`, `/library`), as documented in
 *   docs/MAIN-SITE-HANDOFF-REQUEST.md. Read-only: purchases reach HCG only through the separate grant
 *   outbox (grants.ts), so canGrant = false here.
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

/** What is being checked: one product, and one edition of it when the product has editions. */
export interface CheckTarget {
  centralProductId: string;
  /** Store edition ID; null only for products without editions. */
  editionId: string | null;
  /** The edition's central key (decision D2), or null when it is not mapped centrally. */
  centralEditionKey: string | null;
}

export interface EntitlementAuthority {
  readonly kind: "none" | "test-ledger" | "hcg-ecosystem";
  /** Whether verified purchases can be turned into entitlements. */
  readonly canGrant: boolean;
  check(subject: Subject, target: CheckTarget): Promise<CheckResult>;
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

  async check(subject: Subject, { centralProductId, editionId }: CheckTarget): Promise<CheckResult> {
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
 * HCG's central Ecosystem API, `https://beta.hakmicapitalgroup.com/api/public/ecosystem/v1`.
 *
 * Contract (main-site handoff, 16 Nov 2026):
 * - `GET /me` (DEPLOYED) lists the caller's organisations. Licences belong to organisations, so the
 *   Store checks each organisation the person belongs to.
 * - `POST /check {org_id, product_id, feature_key}` (DEPLOYED) answers `{allowed, layer, reason}`.
 *   The deployed route has no edition: it ignores an `edition` field.
 * - Edition check (decision D2, PROPOSED, not deployed): the request adds `edition`, and the
 *   response echoes it with `edition_scope` "edition" or "all-editions". A product with editions is
 *   granted ONLY on such an explicit answer. An answer that does not confirm the edition, a product-
 *   wide grant, or an unmapped edition is "access unknown", never a grant (no silent fallback).
 * - `GET /library` (PREVIEW, not published) lists licences for display only.
 *
 * Anything unexpected is "unavailable", never a grant. Grants are never cached across requests.
 */
const MAX_ORGS = 20;

interface MeResponse {
  api_version?: unknown;
  organisations?: { org_id?: unknown }[];
}

interface CheckResponse {
  api_version?: unknown;
  org_id?: unknown;
  product_id?: unknown;
  feature_key?: unknown;
  allowed?: unknown;
  edition?: unknown;
  edition_scope?: unknown;
}

export const DOWNLOAD_FEATURE = "download";

export class HcgEcosystemAuthority implements EntitlementAuthority {
  readonly kind = "hcg-ecosystem" as const;
  readonly canGrant = false;
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(path: string, token: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      const type = res.headers.get("content-type") ?? "";
      // A route that is not deployed answers with the site's HTML page, not JSON.
      const json = type.includes("application/json") ? ((await res.json()) as unknown) : null;
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  /** The organisations the person belongs to, or null when HCG cannot say. */
  async organisations(token: string): Promise<string[] | null> {
    const r = await this.call("/me", token);
    if (!r || r.status !== 200 || !r.json) return null;
    const me = r.json as MeResponse;
    if (me.api_version !== "v1" || !Array.isArray(me.organisations)) return null;
    const ids = me.organisations.map((o) => o.org_id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return [...new Set(ids)].slice(0, MAX_ORGS);
  }

  async check(subject: Subject, target: CheckTarget): Promise<CheckResult> {
    if (!subject.accessToken) return { status: "unavailable", reason: "No HCG access token." };
    const wantsEdition = target.editionId !== null;
    if (wantsEdition && !target.centralEditionKey) {
      // D2: an edition HCG has no key for is never checked against a product-wide grant.
      return { status: "unavailable", reason: "This edition is not mapped to HCG's central licensing yet." };
    }
    const orgs = await this.organisations(subject.accessToken);
    if (orgs === null) return { status: "unavailable", reason: "HCG could not confirm the account's organisations." };
    // Licences belong to organisations. A person in none holds no licence (handoff: "Critical finding").
    if (!orgs.length) return { status: "not-granted" };

    let unknown = false;
    for (const org of orgs) {
      const body: Record<string, string> = { org_id: org, product_id: target.centralProductId, feature_key: DOWNLOAD_FEATURE };
      if (wantsEdition) body.edition = target.centralEditionKey!;
      const r = await this.call("/check", subject.accessToken, body);
      if (!r) {
        unknown = true;
        continue;
      }
      if (r.status === 403) continue; // not a member of that organisation any more
      if (r.status !== 200 || !r.json) {
        unknown = true;
        continue;
      }
      const c = r.json as CheckResponse;
      const echoes = c.api_version === "v1" && c.org_id === org && c.product_id === target.centralProductId && c.feature_key === DOWNLOAD_FEATURE;
      if (!echoes || typeof c.allowed !== "boolean") {
        unknown = true;
        continue;
      }
      if (wantsEdition) {
        // The answer must say it evaluated exactly this edition. The deployed route does not, so
        // edition checks stay "unknown" until HCG ships the edition check (D2).
        const editionConfirmed = c.edition === target.centralEditionKey && (c.edition_scope === "edition" || c.edition_scope === "all-editions");
        if (!editionConfirmed) {
          unknown = true;
          continue;
        }
      }
      if (c.allowed) return { status: "granted", expiresAt: null };
    }
    return unknown ? { status: "unavailable", reason: "HCG did not confirm access for this edition." } : { status: "not-granted" };
  }

  /** Display only (PREVIEW route). Never used to decide access. */
  async list(subject: Subject) {
    if (!subject.accessToken) return { status: "unavailable" as const, reason: "No HCG access token." };
    const r = await this.call("/library", subject.accessToken);
    if (!r || r.status !== 200 || !r.json) return { status: "unavailable" as const, reason: "HCG's library route is not available." };
    const lib = r.json as { api_version?: unknown; items?: unknown };
    if (lib.api_version !== "v1" || !Array.isArray(lib.items)) return { status: "unavailable" as const, reason: "HCG's library answer was not recognised." };
    const items: OwnedItem[] = [];
    for (const raw of lib.items as Record<string, unknown>[]) {
      if (raw.status !== "active" || typeof raw.product_id !== "string") continue;
      const ends = typeof raw.ends_at === "string" ? Date.parse(raw.ends_at) : null;
      if (ends !== null && (!Number.isFinite(ends) || ends <= this.now())) continue;
      // Editions are module-scope licences "edition:<key>" (D2); "edition:*" is the explicit all-editions licence.
      if (raw.scope === "module" && typeof raw.scope_key === "string" && raw.scope_key.startsWith("edition:")) {
        items.push({ centralProductId: raw.product_id, edition: raw.scope_key.slice("edition:".length), expiresAt: ends });
      }
    }
    return { status: "ok" as const, items };
  }

  grant(): void {
    throw new Error(UNSUPPORTED);
  }
  revoke(): void {
    throw new Error(UNSUPPORTED);
  }
}
