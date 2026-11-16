/**
 * Outbox of purchase grants for HCG's central licensing (decision D5).
 *
 * HCG holds licences; HCG Store only reports verified purchases to it. The central endpoint is
 * PROPOSED in docs/MAIN-SITE-HANDOFF-REQUEST.md (`POST /api/public/store/v1/entitlements`) and is not
 * deployed, so this outbox is inert until an operator configures both HCG_STORE_GRANT_API_URL and
 * HCG_STORE_GRANT_CREDENTIAL.
 *
 * Rules:
 * - Only the payment ledger writes here, after a provider event's signature has been verified,
 *   inside the same transaction. No HTTP route, browser or client flag can add a grant.
 * - One record per purchase and edition. Its key is namespaced by provider and environment:
 *   `store:<provider>:<environment>:<purchase id>:<edition>`. A revoke affects that record only, so
 *   access from another valid purchase is untouched.
 * - The environment comes from the server's mode (test or production), never from a request.
 *   HCG binds each credential to one environment and must refuse a mismatch.
 * - Revoked is terminal: a later or delayed grant can never reactivate a revoked purchase. Every
 *   change raises `revision`; HCG applies a revision only if it is newer than the one it holds, so
 *   duplicate and out-of-order deliveries are safe and deterministic.
 * - The credential is sent only in the Authorization header. It is never stored in the database,
 *   written to logs or included in errors.
 */
import type { Db } from "./db";

export interface GrantSettings {
  url: string;
  credential: string;
  environment: "test" | "production";
}

export type GrantReason = "refund" | "chargeback" | "subscription_ended" | "admin";

interface Row {
  purchase_key: string;
  sub: string;
  product_id: string;
  edition: string | null;
  state: "active" | "revoked";
  reason: string | null;
  starts_at: number;
  ends_at: number | null;
  revision: number;
  attempts: number;
}

export interface DeliveryReport {
  delivered: number;
  failed: number;
}

const MAX_BACKOFF_MS = 60 * 60 * 1000;

export class CentralGrantOutbox {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly settings: GrantSettings | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.settings !== null;
  }

  get environment(): GrantSettings["environment"] | null {
    return this.settings?.environment ?? null;
  }

  key(provider: string, purchaseId: string, edition: string | null): string {
    if (!this.settings) throw new Error("Central grants are not configured.");
    return `store:${provider}:${this.settings.environment}:${purchaseId}:${edition ?? "product"}`;
  }

  /** Grant or extend. Never reactivates a revoked purchase. Call inside the ledger transaction. */
  setActive(key: string, sub: string, productId: string, edition: string | null, startsAt: number, endsAt: number | null): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO central_grants (purchase_key, sub, product_id, edition, state, starts_at, ends_at, revision, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?)
         ON CONFLICT (purchase_key) DO UPDATE SET
           ends_at = excluded.ends_at, revision = revision + 1, next_attempt_at = 0, updated_at = excluded.updated_at
         WHERE central_grants.state = 'active'
           AND (central_grants.ends_at IS NOT NULL AND (excluded.ends_at IS NULL OR excluded.ends_at > central_grants.ends_at))`,
      )
      .run(key, sub, productId, edition, startsAt, endsAt, t);
  }

  /** Terminal. A purchase that was never granted has nothing to revoke centrally. */
  setRevoked(key: string, reason: GrantReason): void {
    this.db
      .prepare(
        `UPDATE central_grants SET state = 'revoked', reason = ?, revision = revision + 1, next_attempt_at = 0, updated_at = ?
         WHERE purchase_key = ? AND state = 'active'`,
      )
      .run(reason, this.now(), key);
  }

  pending(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM central_grants WHERE delivered_revision < revision`).get() as { n: number }).n;
  }

  /** Send every record whose latest revision HCG has not confirmed. Safe to call concurrently with itself only from one process. */
  async deliver(limit = 25): Promise<DeliveryReport> {
    const report: DeliveryReport = { delivered: 0, failed: 0 };
    if (!this.settings) return report;
    const rows = this.db
      .prepare(
        `SELECT purchase_key, sub, product_id, edition, state, reason, starts_at, ends_at, revision, attempts
         FROM central_grants WHERE delivered_revision < revision AND next_attempt_at <= ? ORDER BY updated_at LIMIT ?`,
      )
      .all(this.now(), limit) as unknown as Row[];
    for (const row of rows) {
      const outcome = await this.send(row);
      if (outcome === "ok") {
        // Only mark the revision that was sent; a change made meanwhile is sent next time.
        this.db
          .prepare(`UPDATE central_grants SET delivered_revision = MAX(delivered_revision, ?), attempts = 0, last_error = NULL WHERE purchase_key = ?`)
          .run(row.revision, row.purchase_key);
        report.delivered += 1;
      } else {
        const attempts = row.attempts + 1;
        const backoff = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts - 1, 10));
        this.db
          .prepare(`UPDATE central_grants SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE purchase_key = ?`)
          .run(attempts, this.now() + backoff, outcome.error, row.purchase_key);
        report.failed += 1;
      }
    }
    return report;
  }

  private body(row: Row) {
    const base = { purchase_id: row.purchase_key, revision: row.revision, environment: this.settings!.environment };
    if (row.state === "revoked") return { ...base, action: "revoke", reason: row.reason };
    return {
      ...base,
      action: "grant",
      sub: row.sub,
      product_id: row.product_id,
      edition: row.edition,
      starts_at: new Date(row.starts_at).toISOString(),
      ends_at: row.ends_at === null ? null : new Date(row.ends_at).toISOString(),
    };
  }

  private async send(row: Row): Promise<"ok" | { error: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.settings!.url, {
        method: "POST",
        headers: { authorization: `HCG-Store-Server ${this.settings!.credential}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(this.body(row)),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch (e) {
      return { error: `network: ${e instanceof Error ? e.name : "error"}` };
    }
    let code = "";
    try {
      const j = (await res.json()) as { error?: { code?: unknown }; purchase_id?: unknown; status?: unknown };
      if (res.ok) {
        // HCG must answer for this exact purchase; a revoke must come back revoked.
        if (j.purchase_id === row.purchase_key && (row.state !== "revoked" || j.status === "revoked")) return "ok";
        return { error: `unexpected answer (HTTP ${res.status})` };
      }
      code = typeof j.error?.code === "string" ? j.error.code.slice(0, 60) : "";
    } catch {
      code = "";
    }
    // A revoke HCG already applied is done. Everything else is retried later (errors are visible to operators).
    if (row.state === "revoked" && res.status === 409 && code === "already_revoked") return "ok";
    return { error: `HTTP ${res.status}${code ? ` ${code}` : ""}` };
  }
}
