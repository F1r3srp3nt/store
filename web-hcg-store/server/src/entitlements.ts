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

/** HCG's Founder product-ownership policy key (shared product-access handoff, 18 Nov 2026). */
export const FOUNDER_POLICY = "founder_owner_all_products";

/** One product's feature as HCG's /access reports it for this account. */
export interface FeatureAccess {
  key: string;
  enabled: boolean;
  allowed: boolean;
  source: string | null;
  reason: string | null;
}

/** What HCG's /access reports for one product and this account. Display only: /check decides protected actions. */
export interface ProductAccess {
  centralProductId: string;
  name: string | null;
  /** HCG's registry release status (e.g. in_development, planned, live). Not Store release availability. */
  releaseStatus: string | null;
  /** "founder_owner" only when HCG's answer confirms the Founder policy for this product. */
  kind: "founder_owner" | "organisation_license" | "none" | "unknown";
  entitlementSource: string | null;
  editions: "all" | string[];
  features: FeatureAccess[];
}

export type AccountAccess =
  | { status: "ok"; founderPolicy: boolean; displayName: string | null; products: ProductAccess[] }
  | { status: "unavailable"; reason: string };

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
  /**
   * A central feature of one product, e.g. the staff permissions `store.publish` and `store.release.approve`
   * (main-site plan, 16 Nov 2026), checked for the product they are scoped to. Never inferred from owning the
   * product, from a role, or from anything the client sends.
   */
  checkFeature(subject: Subject, centralProductId: string, featureKey: string): Promise<CheckResult>;
  list(subject: Subject): Promise<{ status: "ok"; items: OwnedItem[] } | { status: "unavailable"; reason: string }>;
  /**
   * What HCG reports this account can use, per registered product, for display ("My HCG apps"): /me (Founder policy,
   * display name, organisations), /library (registered products for the Founder, licences) and /access per product.
   * `candidates` are central product IDs the Store knows; the Founder's list comes from HCG. Access decisions for
   * protected actions still go through check().
   */
  accountAccess(subject: Subject, candidates: string[]): Promise<AccountAccess>;
  /** Synchronous, so it can run inside the payment-event transaction (test ledger only). */
  grant(sub: string, centralProductId: string, edition: string, source: string, expiresAt: number | null): void;
  revoke(sub: string, centralProductId: string, edition: string, source: string): void;
}

/** How the TEST ledger stores a central feature (permission) next to edition entitlements. */
export const featureEdition = (featureKey: string) => `feature:${featureKey}`;

const UNSUPPORTED = "HCG has not published an entitlement grant API. Purchases cannot be fulfilled.";

export class NoAuthority implements EntitlementAuthority {
  readonly kind = "none" as const;
  readonly canGrant = false;
  async check(): Promise<CheckResult> {
    return { status: "unavailable", reason: "No entitlement authority is configured." };
  }
  async checkFeature(): Promise<CheckResult> {
    return { status: "unavailable", reason: "No entitlement authority is configured." };
  }
  async list() {
    return { status: "unavailable" as const, reason: "No entitlement authority is configured." };
  }
  async accountAccess(): Promise<AccountAccess> {
    return { status: "unavailable", reason: "No entitlement authority is configured." };
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

  /** TEST stand-in for a central feature: a row with edition `feature:<key>` for the product (or "*", test only). */
  async checkFeature(subject: Subject, centralProductId: string, featureKey: string): Promise<CheckResult> {
    const rows = this.db
      .prepare(
        `SELECT expires_at FROM test_entitlements
         WHERE sub = ? AND (product_id = ? OR product_id = '*') AND edition = ? AND status = 'active'`,
      )
      .all(subject.sub, centralProductId, featureEdition(featureKey)) as { expires_at: number | null }[];
    return rows.some((r) => r.expires_at === null || r.expires_at > this.now()) ? { status: "granted", expiresAt: null } : { status: "not-granted" };
  }

  async list(subject: Subject) {
    const rows = this.db
      .prepare(`SELECT product_id, edition, expires_at FROM test_entitlements WHERE sub = ? AND status = 'active'`)
      .all(subject.sub) as { product_id: string; edition: string; expires_at: number | null }[];
    const items = rows
      .filter((r) => !r.edition.startsWith("feature:") && (r.expires_at === null || r.expires_at > this.now()))
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

  private readonly founders = new Set<string>();

  /** TEST stand-in for HCG's Founder product-ownership policy (activated and revoked by HCG's Owner, never by the Store). */
  setFounderPolicy(sub: string, on: boolean): void {
    if (on) this.founders.add(sub);
    else this.founders.delete(sub);
  }

  async accountAccess(subject: Subject, candidates: string[]): Promise<AccountAccess> {
    const founder = this.founders.has(subject.sub);
    const rows = this.db
      .prepare(`SELECT product_id, edition, expires_at FROM test_entitlements WHERE sub = ? AND status = 'active' AND edition NOT LIKE 'feature:%'`)
      .all(subject.sub) as { product_id: string; edition: string; expires_at: number | null }[];
    const live = rows.filter((r) => r.expires_at === null || r.expires_at > this.now());
    const ids = [...new Set([...candidates, ...live.map((r) => r.product_id)])];
    const products = ids.map((id): ProductAccess => {
      const mine = live.filter((r) => r.product_id === id);
      const editions: "all" | string[] = founder || mine.some((r) => r.edition === "*" || r.edition === "default") ? "all" : mine.map((r) => r.edition);
      return {
        centralProductId: id,
        name: null,
        releaseStatus: "in_development",
        kind: founder ? "founder_owner" : mine.length ? "organisation_license" : "none",
        entitlementSource: founder ? FOUNDER_POLICY : mine.length ? "organisation_license" : null,
        editions: founder ? "all" : editions,
        features: [{ key: "download", enabled: true, allowed: founder || mine.length > 0, source: founder ? FOUNDER_POLICY : mine.length ? "organisation_license" : null, reason: null }],
      };
    });
    return { status: "ok", founderPolicy: founder, displayName: null, products };
  }

  /** Test helper: revoke everything for a subject (simulates an HCG administrator revoking access). */
  revokeAll(sub: string): void {
    this.db.prepare(`UPDATE test_entitlements SET status = 'revoked', updated_at = ? WHERE sub = ?`).run(this.now(), sub);
    this.founders.delete(sub);
  }
}

/**
 * HCG's /access answer for one product, read defensively. The Founder kind is accepted only when the answer itself says
 * so for this product (owned, kind founder_owner, policy and source founder_owner_all_products); anything unexpected
 * is "unknown", never access.
 */
export function parseAccess(json: unknown, productId: string): ProductAccess {
  const unknown: ProductAccess = { centralProductId: productId, name: null, releaseStatus: null, kind: "unknown", entitlementSource: null, editions: [], features: [] };
  const a = json as {
    api_version?: unknown; product?: { product_id?: unknown; name?: unknown; release_status?: unknown };
    ownership?: { owned?: unknown; kind?: unknown; policy_key?: unknown }; entitlement_source?: unknown; editions?: unknown; feature_details?: unknown;
  };
  if (!a || a.api_version !== "v1" || a.product?.product_id !== productId || !a.ownership) return unknown;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const owned = a.ownership.owned === true;
  let kind: ProductAccess["kind"] = "none";
  if (owned && a.ownership.kind === "founder_owner" && a.ownership.policy_key === FOUNDER_POLICY && a.entitlement_source === FOUNDER_POLICY) kind = "founder_owner";
  else if (owned && a.ownership.kind === "organisation_license" && a.entitlement_source === "organisation_license") kind = "organisation_license";
  else if (owned || a.ownership.kind !== "none") return { ...unknown, name: str(a.product.name), releaseStatus: str(a.product.release_status) };
  const editions: "all" | string[] = a.editions === "all" ? "all" : Array.isArray(a.editions) ? a.editions.filter((e): e is string => typeof e === "string") : [];
  const features = (Array.isArray(a.feature_details) ? a.feature_details : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as { feature_key?: unknown }).feature_key === "string")
    .map((f) => ({ key: f.feature_key as string, enabled: f.enabled === true, allowed: f.allowed === true, source: str(f.entitlement_source), reason: str(f.reason) }));
  return { centralProductId: productId, name: str(a.product.name), releaseStatus: str(a.product.release_status), kind, entitlementSource: kind === "none" ? null : str(a.entitlement_source), editions: kind === "none" ? [] : editions, features };
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

/**
 * `GET /me` (DEPLOYED): the account HCG's Ecosystem API sees for an access token. Used once at sign-in
 * to confirm that the account the Store verified from the tokens is the one HCG's API recognises.
 */
export async function fetchMe(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "ok"; userId: string; displayName: string | null } | { status: "unauthorized" } | { status: "unavailable"; reason: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}/me`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (res.status === 401) return { status: "unauthorized" };
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !type.includes("application/json")) return { status: "unavailable", reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { api_version?: unknown; user?: { id?: unknown; display_name?: unknown } };
    if (body.api_version !== "v1" || typeof body.user?.id !== "string") return { status: "unavailable", reason: "unrecognised answer" };
    const dn = typeof body.user.display_name === "string" ? body.user.display_name.trim().slice(0, 120) : "";
    return { status: "ok", userId: body.user.id, displayName: dn || null };
  } catch (e) {
    return { status: "unavailable", reason: e instanceof Error ? e.name : "error" };
  }
}

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
    if (target.editionId !== null && !target.centralEditionKey) {
      // D2: an edition HCG has no key for is never checked against a product-wide grant.
      return { status: "unavailable", reason: "This edition is not mapped to HCG's central licensing yet." };
    }
    return this.decide(subject, target.centralProductId, DOWNLOAD_FEATURE, target.editionId !== null ? target.centralEditionKey : null);
  }

  /**
   * A product-scoped central feature (no edition): `POST /check {org_id, product_id, feature_key}` exactly as
   * deployed. Granted only on `allowed: true` echoing this organisation, product and feature.
   */
  async checkFeature(subject: Subject, centralProductId: string, featureKey: string): Promise<CheckResult> {
    return this.decide(subject, centralProductId, featureKey, null);
  }

  private async decide(subject: Subject, centralProductId: string, featureKey: string, editionKey: string | null): Promise<CheckResult> {
    if (!subject.accessToken) return { status: "unavailable", reason: "No HCG access token." };
    const wantsEdition = editionKey !== null;
    const orgs = await this.organisations(subject.accessToken);
    if (orgs === null) return { status: "unavailable", reason: "HCG could not confirm the account's organisations." };
    // Licences belong to organisations. A person in none holds no licence (handoff: "Critical finding").
    if (!orgs.length) return { status: "not-granted" };

    let unknown = false;
    for (const org of orgs) {
      const body: Record<string, string> = { org_id: org, product_id: centralProductId, feature_key: featureKey };
      if (wantsEdition) body.edition = editionKey;
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
      const echoes = c.api_version === "v1" && c.org_id === org && c.product_id === centralProductId && c.feature_key === featureKey;
      if (!echoes || typeof c.allowed !== "boolean") {
        unknown = true;
        continue;
      }
      if (wantsEdition) {
        // The answer must say it evaluated exactly this edition. The deployed route does not, so
        // edition checks stay "unknown" until HCG ships the edition check (D2).
        const editionConfirmed = c.edition === editionKey && (c.edition_scope === "edition" || c.edition_scope === "all-editions");
        if (!editionConfirmed) {
          unknown = true;
          continue;
        }
      }
      if (c.allowed) return { status: "granted", expiresAt: null };
    }
    return unknown ? { status: "unavailable", reason: wantsEdition ? "HCG did not confirm access for this edition." : "HCG did not confirm this access." } : { status: "not-granted" };
  }

  async accountAccess(subject: Subject, candidates: string[]): Promise<AccountAccess> {
    const token = subject.accessToken;
    if (!token) return { status: "unavailable", reason: "No HCG access token." };
    const [meR, libR] = await Promise.all([this.call("/me", token), this.call("/library", token)]);
    if (!meR || meR.status !== 200 || !meR.json) return { status: "unavailable", reason: "HCG's /me did not answer." };
    const me = meR.json as { api_version?: unknown; user?: { display_name?: unknown }; organisations?: { org_id?: unknown }[]; product_policy?: { active?: unknown; policy_key?: unknown } };
    if (me.api_version !== "v1") return { status: "unavailable", reason: "HCG's /me answer was not recognised." };
    const founderPolicy = me.product_policy?.active === true && me.product_policy.policy_key === FOUNDER_POLICY;
    const orgs = (Array.isArray(me.organisations) ? me.organisations : []).map((o) => o.org_id).filter((id): id is string => typeof id === "string").slice(0, MAX_ORGS);
    const lib = libR?.status === 200 && libR.json ? (libR.json as { api_version?: unknown; items?: unknown; founder_ownership?: unknown }) : null;
    const licensed = Array.isArray(lib?.items) ? (lib!.items as { product_id?: unknown; status?: unknown }[]).filter((i) => i.status === "active").map((i) => i.product_id).filter((p): p is string => typeof p === "string") : [];
    const registered = founderPolicy && Array.isArray(lib?.founder_ownership)
      ? (lib!.founder_ownership as { product_id?: unknown }[]).map((p) => p.product_id).filter((p): p is string => typeof p === "string")
      : [];
    const ids = [...new Set([...registered, ...candidates, ...licensed])].filter((id) => /^[a-z0-9][a-z0-9._-]{1,79}$/.test(id)).slice(0, 80);
    const one = async (id: string): Promise<ProductAccess> => {
      // The Founder needs no organisation; an ordinary account is asked per organisation it belongs to.
      const queries = founderPolicy ? [""] : orgs;
      let best: ProductAccess = { centralProductId: id, name: null, releaseStatus: null, kind: orgs.length || founderPolicy ? "unknown" : "none", entitlementSource: null, editions: [], features: [] };
      for (const org of queries) {
        const r = await this.call(`/access?product=${encodeURIComponent(id)}${org ? `&org=${encodeURIComponent(org)}` : ""}`, token);
        if (!r || r.status !== 200 || !r.json) continue;
        const a = parseAccess(r.json, id);
        const rank = { founder_owner: 3, organisation_license: 2, none: 1, unknown: 0 } as const;
        if (rank[a.kind] > rank[best.kind] || (best.kind === "unknown" && a.name)) best = a;
      }
      return best;
    };
    const products: ProductAccess[] = [];
    for (let k = 0; k < ids.length; k += 6) products.push(...(await Promise.all(ids.slice(k, k + 6).map(one))));
    const displayName = typeof me.user?.display_name === "string" ? me.user.display_name : null;
    return { status: "ok", founderPolicy, displayName, products };
  }

  /** Display only. Never used to decide access. */
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
