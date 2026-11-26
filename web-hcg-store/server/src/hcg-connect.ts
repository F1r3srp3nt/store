/**
 * HCG Connect relying party (server side). Follows the contract HCG's identity provider already
 * serves (Supabase Auth OAuth 2.1 server): authorization code + PKCE S256, ES256-signed tokens,
 * refresh-token rotation, no revocation or end-session endpoint.
 *
 * The browser never sees an HCG token: tokens stay on the server, sealed at rest, and the browser
 * holds only an opaque HttpOnly session cookie.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { HcgConnectSettings } from "./config";

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface Identity {
  sub: string;
  email: string | null;
  name: string | null;
}

/** Refresh outcomes. "ended": HCG says the session no longer exists. "unavailable": try later. */
export type RefreshResult =
  | { status: "ok"; tokens: TokenSet; sub: string }
  | { status: "ended"; reason: string }
  | { status: "unavailable"; reason: string };

/** Error codes the provider uses for a refresh token that can never work again. */
const DEAD_REFRESH_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "invalid_grant",
  "user_not_found",
  "user_banned",
]);

export class HcgConnectClient {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly s: HcgConnectSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.jwks = createRemoteJWKSet(new URL(s.jwksUri), { cacheMaxAge: 60 * 60 * 1000, cooldownDuration: 30_000 });
  }

  get clientId() {
    return this.s.clientId;
  }

  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string }): string {
    const u = new URL(this.s.authorizationEndpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.s.clientId);
    u.searchParams.set("redirect_uri", this.s.redirectUri);
    u.searchParams.set("scope", this.s.scopes);
    u.searchParams.set("state", p.state);
    u.searchParams.set("nonce", p.nonce);
    u.searchParams.set("code_challenge", p.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; status: number; code: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.s.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...body, client_id: this.s.clientId }).toString(),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      return { ok: false, status: 0, code: "network" };
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const code = String(json.error_code ?? json.error ?? `http_${res.status}`);
      return { ok: false, status: res.status, code };
    }
    return { ok: true, json };
  }

  private tokenSet(json: Record<string, unknown>, previousRefresh: string | null): TokenSet | null {
    const accessToken = typeof json.access_token === "string" ? json.access_token : null;
    if (!accessToken) return null;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : previousRefresh;
    return { accessToken, refreshToken, expiresAt: this.now() + expiresIn * 1000 };
  }

  /** Verifies the access token's signature, issuer and subject, and that it was issued to this client. */
  async verifyAccessToken(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.s.issuer,
      algorithms: ["ES256", "RS256"],
      clockTolerance: 120,
      currentDate: new Date(this.now()),
    });
    if (!payload.sub) throw new Error("Access token has no subject.");
    if (payload.client_id !== undefined && payload.client_id !== this.s.clientId) throw new Error("Access token was issued to another client.");
    return payload;
  }

  /**
   * Verifies a bearer access token presented to the publishing API: signature (JWKS), issuer, subject, and that it
   * was issued to one of the allow-listed HCG Connect clients (e.g. HCG Executable Maker). Never the Store's own
   * session token: those stay server-side.
   */
  async verifyAccessTokenFrom(token: string, allowedClientIds: string[]): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.s.issuer,
      algorithms: ["ES256", "RS256"],
      clockTolerance: 30,
      currentDate: new Date(this.now()),
    });
    if (!payload.sub) throw new Error("Access token has no subject.");
    if (typeof payload.client_id !== "string" || !allowedClientIds.includes(payload.client_id)) {
      throw new Error("This application is not allowed to publish to HCG Store.");
    }
    return payload;
  }

  /**
   * Diagnostics only (GET /api/v1/publishing/status): checks a bearer token's signature, issuer, subject and expiry
   * WITHOUT the client allow-list, so the Store can say precisely which part failed. Never authorises anything.
   */
  async inspectAccessToken(token: string): Promise<{ valid: true; payload: JWTPayload } | { valid: false; code: "expired" | "invalid" | "unverifiable"; reason: string }> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.s.issuer,
        algorithms: ["ES256", "RS256"],
        clockTolerance: 30,
        currentDate: new Date(this.now()),
      });
      if (!payload.sub) return { valid: false, code: "invalid", reason: "Access token has no subject." };
      return { valid: true, payload };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "ERR_JWT_EXPIRED") return { valid: false, code: "expired", reason: "The access token has expired." };
      // HCG Connect's signing keys could not be fetched: not the token's fault.
      if (["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(code) || e instanceof TypeError) return { valid: false, code: "unverifiable", reason: `HCG Connect's signing keys could not be fetched (${(e as Error).message}).` };
      return { valid: false, code: "invalid", reason: (e as Error).message };
    }
  }

  async exchangeCode(code: string, verifier: string, nonce: string): Promise<{ tokens: TokenSet; identity: Identity }> {
    const r = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.s.redirectUri, code_verifier: verifier });
    if (!r.ok) throw new Error(`Code exchange failed (${r.code}).`);
    const tokens = this.tokenSet(r.json, null);
    const idToken = typeof r.json.id_token === "string" ? r.json.id_token : null;
    if (!tokens || !idToken) throw new Error("Token response is missing the access or ID token.");
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: this.s.issuer,
      audience: this.s.clientId,
      algorithms: ["ES256", "RS256"],
      clockTolerance: 120,
      currentDate: new Date(this.now()),
    });
    if (payload.nonce !== nonce) throw new Error("ID token nonce does not match.");
    if (!payload.sub) throw new Error("ID token has no subject.");
    const access = await this.verifyAccessToken(tokens.accessToken);
    if (access.sub !== payload.sub) throw new Error("Access token subject differs from the ID token.");
    const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
    return {
      tokens,
      identity: { sub: payload.sub, email: str(payload.email), name: str(payload.name) ?? str((payload as { full_name?: unknown }).full_name) },
    };
  }

  async refresh(refreshToken: string, expectedSub: string): Promise<RefreshResult> {
    const r = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!r.ok) {
      if (r.status === 0 || r.status === 429 || r.status >= 500) return { status: "unavailable", reason: `HCG Connect unavailable (${r.code}).` };
      if (DEAD_REFRESH_CODES.has(r.code) || r.status === 400 || r.status === 401) return { status: "ended", reason: r.code };
      return { status: "unavailable", reason: r.code };
    }
    const tokens = this.tokenSet(r.json, refreshToken);
    if (!tokens) return { status: "unavailable", reason: "Malformed token response." };
    try {
      const access = await this.verifyAccessToken(tokens.accessToken);
      if (access.sub !== expectedSub) return { status: "ended", reason: "subject_changed" };
      return { status: "ok", tokens, sub: access.sub! };
    } catch {
      return { status: "unavailable", reason: "Refreshed access token could not be verified." };
    }
  }
}
