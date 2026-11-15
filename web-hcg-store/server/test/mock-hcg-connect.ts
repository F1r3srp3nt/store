/**
 * TEST ONLY. A local stand-in for HCG Connect that follows the contract the real provider serves
 * (Supabase Auth OAuth 2.1 server): authorization code + PKCE S256, ES256 tokens with the ID token's
 * `aud` = client ID and the access token's `aud` = "authenticated" plus `client_id`, rotating refresh
 * tokens, and provider error codes such as `session_not_found`. It never runs in production.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

export interface MockUser {
  sub: string;
  email: string;
  name?: string;
  /** HCG account role. Present in tokens; must never imply ownership. */
  role?: string;
}

interface CodeRecord {
  user: MockUser;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
}

export class MockHcgConnect {
  server!: Server;
  origin = "";
  clientId = "11111111-2222-4333-8444-555555555555";
  nextUser: MockUser | null = null;
  down = false;
  private key!: CryptoKey;
  private jwk!: JWK;
  private codes = new Map<string, CodeRecord>();
  /** refresh token → { user, session id } */
  private refresh = new Map<string, { user: MockUser; sid: string }>();
  private usedRefresh = new Set<string>();
  private endedSessions = new Set<string>();
  sessionsBySub = new Map<string, string[]>();
  now: () => number = Date.now;
  accessTtlSeconds = 3600;
  /** Enables POST /__test/next-user/<sub> so browser tests can choose who signs in next. */
  controlEndpoint = false;
  tokenRequests = 0;

  get issuer() {
    return `${this.origin}/auth/v1`;
  }

  async start(port = 0) {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    this.key = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: "mock-key-1", alg: "ES256", use: "sig" };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.server.listen(port, "127.0.0.1", ok));
    const addr = this.server.address();
    this.origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  stop() {
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }

  /** Simulates the person's HCG session being revoked centrally (sign-out elsewhere, ban, deletion). */
  endSessionsFor(sub: string) {
    for (const sid of this.sessionsBySub.get(sub) ?? []) this.endedSessions.add(sid);
  }

  private async sign(claims: Record<string, unknown>, aud: string, ttl: number) {
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "mock-key-1" })
      .setIssuer(this.issuer)
      .setAudience(aud)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.key);
  }

  private async tokens(user: MockUser, sid: string, nonce?: string) {
    const refresh = randomBytes(24).toString("base64url");
    this.refresh.set(refresh, { user, sid });
    const access = await this.sign(
      { sub: user.sub, email: user.email, role: user.role ?? "authenticated", client_id: this.clientId, session_id: sid, scope: "openid email profile" },
      "authenticated",
      this.accessTtlSeconds,
    );
    const body: Record<string, unknown> = { access_token: access, token_type: "bearer", expires_in: this.accessTtlSeconds, refresh_token: refresh };
    if (nonce !== undefined) body.id_token = await this.sign({ sub: user.sub, email: user.email, name: user.name, nonce }, this.clientId, 3600);
    return body;
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", this.origin);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (this.controlEndpoint && url.pathname.startsWith("/__test/next-user/")) {
      const sub = decodeURIComponent(url.pathname.slice("/__test/next-user/".length));
      this.nextUser = { sub, email: `${sub}@example.test`, name: sub };
      res.writeHead(204);
      return res.end();
    }
    if (this.down) return send(503, { error: "unavailable" });
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return send(200, { keys: [this.jwk] });
    if (url.pathname === "/auth/v1/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== this.clientId) return send(400, { error_code: "oauth_client_not_found" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return send(400, { error: "invalid_request" });
      const redirect = new URL(q.get("redirect_uri")!);
      if (!this.nextUser) {
        redirect.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(16).toString("hex");
        this.codes.set(code, { user: this.nextUser, clientId: this.clientId, redirectUri: q.get("redirect_uri")!, challenge: q.get("code_challenge")!, nonce: q.get("nonce") ?? "" });
        redirect.searchParams.set("code", code);
      }
      redirect.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === "/auth/v1/oauth/token" && req.method === "POST") {
      this.tokenRequests += 1;
      let raw = "";
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      if (f.get("client_id") !== this.clientId) return send(400, { error_code: "oauth_client_not_found" });
      if (f.get("grant_type") === "authorization_code") {
        const rec = this.codes.get(f.get("code") ?? "");
        this.codes.delete(f.get("code") ?? "");
        if (!rec || rec.redirectUri !== f.get("redirect_uri")) return send(400, { error: "invalid_grant" });
        const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== rec.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        const sid = randomBytes(8).toString("hex");
        this.sessionsBySub.set(rec.user.sub, [...(this.sessionsBySub.get(rec.user.sub) ?? []), sid]);
        return send(200, await this.tokens(rec.user, sid, rec.nonce));
      }
      if (f.get("grant_type") === "refresh_token") {
        const token = f.get("refresh_token") ?? "";
        if (this.usedRefresh.has(token)) return send(400, { error_code: "refresh_token_already_used" });
        const rec = this.refresh.get(token);
        if (!rec) return send(400, { error_code: "refresh_token_not_found" });
        if (this.endedSessions.has(rec.sid)) return send(400, { error_code: "session_not_found" });
        this.usedRefresh.add(token);
        this.refresh.delete(token);
        return send(200, await this.tokens(rec.user, rec.sid));
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    send(404, { error: "not_found" });
  }
}
