/**
 * Store sessions. The browser holds only an opaque random session ID (HttpOnly cookie); the server
 * stores its SHA-256, the HCG subject and the sealed HCG tokens.
 *
 * Revocation model (HCG Connect has no revocation or introspection endpoint):
 * - Store logout ends the Store session immediately and invalidates every HCG Repo token created
 *   from it. It does not sign the person out of HCG itself (no end-session endpoint exists).
 * - Before any protected action, the Store re-confirms the central HCG session when the last
 *   confirmation is older than HCG_STORE_SESSION_RECHECK_SECONDS (default 60) by refreshing the
 *   tokens. If HCG reports the session ended, the Store session ends too. So a central sign-out,
 *   account removal or session revocation takes effect for protected actions within that window.
 * - Entitlements are checked live on every protected request (no caching), so revocation of an
 *   entitlement takes effect on the next request.
 */
import type { StoreConfig } from "./config";
import { randomToken, seal, sha256Hex, unseal } from "./crypto";
import { recordAuthEvent, type Db } from "./db";
import type { HcgConnectClient, Identity, TokenSet } from "./hcg-connect";

export interface Session {
  idHash: string;
  sub: string;
  email: string | null;
  name: string | null;
  accessToken: string | null;
  accessExpiresAt: number;
  refreshToken: string | null;
  centralCheckedAt: number;
  /** When sign-in confirmed this account with HCG's /me, or null if it could not. */
  accountConfirmedAt: number | null;
  createdAt: number;
  lastSeenAt: number;
}

interface Row {
  id_hash: string;
  sub: string;
  email: string | null;
  name: string | null;
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: number;
  central_checked_at: number;
  account_confirmed_at: number | null;
  created_at: number;
  last_seen_at: number;
  ended_at: number | null;
}

export type FreshResult = { status: "ok"; session: Session } | { status: "ended"; reason: string } | { status: "unavailable"; reason: string };

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly cfg: StoreConfig,
    private readonly connect: HcgConnectClient | null,
    private readonly now: () => number,
  ) {}

  get cookieName() {
    return this.cfg.publicOrigin.startsWith("https://") ? "__Host-hcg_store_session" : "hcg_store_session";
  }

  cookie(value: string, maxAgeSeconds: number): string {
    const secure = this.cfg.publicOrigin.startsWith("https://") ? "; Secure" : "";
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  clearCookie(): string {
    return this.cookie("", 0);
  }

  create(identity: Identity, tokens: TokenSet, accountConfirmedAt: number | null = null): { id: string; session: Session } {
    const id = randomToken(32);
    const idHash = sha256Hex(id);
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, sub, email, name, refresh_token, access_token, access_expires_at, central_checked_at, account_confirmed_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idHash,
        identity.sub,
        identity.email,
        identity.name,
        tokens.refreshToken ? seal(this.cfg.secretKey, tokens.refreshToken, `rt:${idHash}`) : null,
        seal(this.cfg.secretKey, tokens.accessToken, `at:${idHash}`),
        tokens.expiresAt,
        t,
        accountConfirmedAt,
        t,
        t,
      );
    return { id, session: this.byHash(idHash)! };
  }

  private toSession(r: Row): Session {
    return {
      idHash: r.id_hash,
      sub: r.sub,
      email: r.email,
      name: r.name,
      accessToken: r.access_token ? unseal(this.cfg.secretKey, r.access_token, `at:${r.id_hash}`) : null,
      accessExpiresAt: r.access_expires_at,
      refreshToken: r.refresh_token ? unseal(this.cfg.secretKey, r.refresh_token, `rt:${r.id_hash}`) : null,
      centralCheckedAt: r.central_checked_at,
      accountConfirmedAt: r.account_confirmed_at,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  /** Active session by hash, applying idle and absolute limits. */
  byHash(idHash: string): Session | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id_hash = ?`).get(idHash) as Row | undefined;
    if (!r || r.ended_at !== null) return null;
    const t = this.now();
    if (t - r.created_at > this.cfg.sessionAbsoluteSeconds * 1000) {
      this.end(idHash, "absolute-timeout");
      return null;
    }
    if (t - r.last_seen_at > this.cfg.sessionIdleSeconds * 1000) {
      this.end(idHash, "idle-timeout");
      return null;
    }
    return this.toSession(r);
  }

  /** Session from the request's cookie value. Updates last-seen. */
  fromCookie(value: string | undefined): Session | null {
    if (!value || value.length < 20 || value.length > 100) return null;
    const s = this.byHash(sha256Hex(value));
    if (s) this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?`).run(this.now(), s.idHash);
    return s;
  }

  end(idHash: string, reason: string): void {
    const t = this.now();
    const ended = this.db
      .prepare(`UPDATE sessions SET ended_at = ?, ended_reason = ?, refresh_token = NULL, access_token = NULL WHERE id_hash = ? AND ended_at IS NULL`)
      .run(t, reason, idHash);
    if (ended.changes) recordAuthEvent(this.db, t, "session_ended", { sessionHash: idHash, detail: { reason, tokensDeleted: true } });
    this.db.prepare(`UPDATE repo_tokens SET revoked_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL`).run(t, idHash);
  }

  /**
   * Re-confirms the central HCG session when the last confirmation is older than the recheck window,
   * or when the access token has expired. Used before every protected action.
   */
  async ensureFresh(session: Session): Promise<FreshResult> {
    const t = this.now();
    const stale = t - session.centralCheckedAt >= this.cfg.sessionRecheckSeconds * 1000;
    const expired = session.accessExpiresAt - 60_000 <= t;
    if (!stale && !expired) return { status: "ok", session };
    if (!this.connect || !session.refreshToken) {
      if (!expired) return { status: "ok", session };
      this.end(session.idHash, "expired");
      return { status: "ended", reason: "expired" };
    }
    const r = await this.connect.refresh(session.refreshToken, session.sub);
    if (r.status !== "ok") recordAuthEvent(this.db, t, "session_refresh_failed", { sessionHash: session.idHash, sub: session.sub, detail: { status: r.status, reason: r.reason } });
    if (r.status === "ended") {
      this.end(session.idHash, `central:${r.reason}`);
      return { status: "ended", reason: r.reason };
    }
    if (r.status === "unavailable") return { status: "unavailable", reason: r.reason };
    this.db
      .prepare(`UPDATE sessions SET refresh_token = ?, access_token = ?, access_expires_at = ?, central_checked_at = ? WHERE id_hash = ?`)
      .run(
        r.tokens.refreshToken ? seal(this.cfg.secretKey, r.tokens.refreshToken, `rt:${session.idHash}`) : null,
        seal(this.cfg.secretKey, r.tokens.accessToken, `at:${session.idHash}`),
        r.tokens.expiresAt,
        t,
        session.idHash,
      );
    recordAuthEvent(this.db, t, "session_refreshed", {
      sessionHash: session.idHash,
      sub: session.sub,
      detail: { refreshTokenRotated: !!r.tokens.refreshToken && r.tokens.refreshToken !== session.refreshToken },
    });
    return { status: "ok", session: this.byHash(session.idHash)! };
  }
}
