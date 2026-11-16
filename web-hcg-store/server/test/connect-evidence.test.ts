// @vitest-environment node
/**
 * The Store's own HCG Connect code against the MOCK identity provider: /me confirmation at sign-in,
 * the auth evidence trail, replay rejection, refresh, logout, and the development-client guard.
 * These test HCG Store's code only. They are not evidence that the real HCG integration works;
 * that comes from `npm run hcg:dev:verify` against the real HCG Connect (docs/HCG-CONNECT-DEV.md).
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEVELOPMENT_CLIENT_IDS, parseStoreConfig } from "../src/config";
import { startHarness, type Harness } from "./harness";

const ALICE = { sub: "user-alice", email: "alice@example.test", name: "Alice" };
const ME_URL = "https://hcg.test/api/public/ecosystem/v1";

/** A mock of HCG's deployed `GET /me`: answers for the token's subject, or for `overrideId`. */
function mockMe(mode: "match" | "other" | "down") {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (mode === "down") return new Response("<!doctype html>", { status: 503, headers: { "content-type": "text/html" } });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const payload = JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1] ?? "", "base64url").toString("utf8")) as { sub: string };
    const id = mode === "match" ? payload.sub : "someone-else";
    return new Response(JSON.stringify({ api_version: "v1", user: { id, email: "a@x" }, organisations: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

const start = (mode: "match" | "other" | "down") => startHarness({ env: { HCG_ECOSYSTEM_API_URL: ME_URL }, ecosystemFetch: mockMe(mode) });
const events = (hh: Harness) => hh.db.prepare("SELECT type, session_ref, sub, detail FROM auth_events ORDER BY id").all() as { type: string; session_ref: string | null; sub: string | null; detail: string | null }[];

describe("HCG Connect sign-in evidence (Store code, mock identity provider)", () => {
  it("confirms the signed-in account with /me and records the flow without tokens", async () => {
    h = await start("match");
    const c = await h.signIn(ALICE);
    const session = (await (await c.get("/api/v1/session")).json()) as { signedIn: boolean; hcgAccountConfirmed: boolean; user: { sub: string } };
    expect(session).toMatchObject({ signedIn: true, hcgAccountConfirmed: true, user: { sub: ALICE.sub } });
    const ev = events(h);
    expect(ev.map((e) => e.type)).toEqual(["login_started", "login_succeeded"]);
    expect(JSON.parse(ev[0]!.detail!)).toMatchObject({ pkce: "S256", redirectUri: `${h.origin}/auth/callback` });
    expect(JSON.parse(ev[1]!.detail!)).toMatchObject({ idTokenVerified: true, accessTokenVerified: true, accountWithMe: "matched" });
    // No JWT, refresh token, code or cookie value is ever written to the evidence trail.
    expect(JSON.stringify(ev)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|refresh_token|code_verifier/);
  });

  it("refuses the sign-in when /me reports a different account", async () => {
    h = await start("other");
    await expect(h.signIn(ALICE)).rejects.toThrow(/callback 400/);
    expect(events(h).map((e) => [e.type, e.detail && JSON.parse(e.detail).reason])).toContainEqual(["login_rejected", "account_mismatch_with_me"]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("keeps the sign-in but marks it unconfirmed when /me is unreachable", async () => {
    h = await start("down");
    const c = await h.signIn(ALICE);
    expect(await (await c.get("/api/v1/session")).json()).toMatchObject({ signedIn: true, hcgAccountConfirmed: false });
  });

  it("rejects replayed, forged and stateless callbacks, and protected requests without a session", async () => {
    h = await start("match");
    const c = h.anonymous();
    h.idp.nextUser = ALICE;
    const begin = await c.get("/auth/login?return_to=/library");
    const authorize = new URL(begin.headers.get("location")!);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    const cb = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
    expect((await c.get(cb.replace(h.origin, ""))).status).toBe(302);
    // The same callback again: the state is single-use.
    expect((await h.anonymous().get(cb.replace(h.origin, ""))).status).toBe(400);
    expect((await h.anonymous().get("/auth/callback?code=x&state=forged-state-value-000000000000")).status).toBe(400);
    expect((await h.anonymous().get("/auth/callback?code=x")).status).toBe(400);
    expect((await h.anonymous().get("/api/v1/library")).status).toBe(401);
    const reasons = events(h).filter((e) => e.type === "login_rejected").map((e) => JSON.parse(e.detail!).reason);
    expect(reasons).toEqual(["state_unknown_or_already_used", "state_unknown_or_already_used", "state_unknown_or_already_used"]);
  });

  it("refreshes with rotation after the recheck window, and logout deletes the session's tokens", async () => {
    h = await start("match");
    const c = await h.signIn(ALICE);
    h.clock.advance(h.cfg.sessionRecheckSeconds + 1);
    expect(await (await c.get("/api/v1/session")).json()).toMatchObject({ signedIn: true });
    const refreshed = events(h).find((e) => e.type === "session_refreshed");
    expect(JSON.parse(refreshed!.detail!)).toEqual({ refreshTokenRotated: true });

    expect((await c.post("/auth/logout")).status).toBe(200);
    const row = h.db.prepare("SELECT ended_reason, refresh_token, access_token FROM sessions").get();
    expect(row).toEqual({ ended_reason: "logout", refresh_token: null, access_token: null });
    expect(events(h).at(-1)).toMatchObject({ type: "session_ended" });
    expect(await (await c.get("/api/v1/session")).json()).toMatchObject({ signedIn: false });
  });
});

describe("development client guard", () => {
  it("refuses the development HCG Connect client in production", () => {
    const base = {
      HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test",
      HCG_STORE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
      HCG_CONNECT_ISSUER: "https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1",
      HCG_CONNECT_AUTHORIZATION_ENDPOINT: "https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1/oauth/authorize",
      HCG_CONNECT_TOKEN_ENDPOINT: "https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1/oauth/token",
      HCG_CONNECT_JWKS_URI: "https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1/.well-known/jwks.json",
      HCG_CONNECT_REDIRECT_URI: "https://store.example.test/auth/callback",
    };
    expect(() => parseStoreConfig({ ...base, HCG_CONNECT_CLIENT_ID: DEVELOPMENT_CLIENT_IDS[0]! })).toThrow(ConfigError);
    expect(() => parseStoreConfig({ ...base, HCG_CONNECT_CLIENT_ID: DEVELOPMENT_CLIENT_IDS[0]! })).toThrow(/development client/);
  });
});
