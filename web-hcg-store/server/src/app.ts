/**
 * HCG Store server: serves the storefront and the account, checkout and protected-delivery APIs.
 *
 *   GET  /api/v1/health
 *   GET  /api/v1/session                       who is signed in (restores the session on page load)
 *   GET  /auth/login?return_to=/path           starts HCG Connect sign-in
 *   GET  /auth/callback                        HCG Connect redirect URI
 *   POST /auth/logout                          ends the Store session
 *   GET  /api/v1/offers                        approved offers (server-authoritative prices)
 *   GET  /api/v1/products/:id/access           per-edition ownership, price and availability
 *   POST /api/v1/checkout                      { offerId } → provider checkout URL
 *   GET  /api/v1/checkout/:id                  status for the return page (never grants anything)
 *   POST /api/v1/payments/webhook/test         signed TEST provider events (test mode only)
 *   GET  /api/v1/library                       owned products and purchase history
 *   GET  /api/v1/downloads/:artifactId         protected file delivery
 *   GET  /api/v1/repo/products/:key/access     access state for HCG Repo product pages (CORS)
 *   /repo-api/v1/sileo/*                       Sileo payment-provider API (see sileo.ts)
 *   GET  /repo-api/v1/files/:signed            short-lived file URL issued to Sileo
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { DOWNLOADS_NOT_AVAILABLE, decideAccess, editionIdsOf, mayDownload, validEdition, type AccessDeps } from "./access";
import type { StoreConfig } from "./config";
import { pkceChallenge, randomToken } from "./crypto";
import { recordAuthEvent, type Db } from "./db";
import { fetchMe, type EntitlementAuthority } from "./entitlements";
import type { CentralGrantOutbox } from "./grants";
import type { HcgConnectClient } from "./hcg-connect";
import { assertSameOrigin, errorJson, escapeHtml, html, HttpError, json, parseCookies, readBody, readJson, redirect, safeReturnTo, send } from "./http";
import { PaymentLedger, signTestEvent, TEST_SIGNATURE_HEADER, verifyTestEvent, type PaymentEventType } from "./payments";
import { findArtifact, findByRepoKey, findProduct, type Registry } from "./registry";
import { getProfile } from "./profiles";
import { createPublishing } from "./publishing";
import { SessionStore, type Session } from "./sessions";
import { handleSileo } from "./sileo";

export interface AppDeps {
  cfg: StoreConfig;
  db: Db;
  registry: Registry;
  connect: HcgConnectClient | null;
  authority: EntitlementAuthority;
  now: () => number;
  /** Reports verified purchases to HCG (decision D5). Inert unless configured. */
  outbox?: CentralGrantOutbox;
  /** fetch used for HCG's Ecosystem API at sign-in (tests inject a mock). */
  ecosystemFetch?: typeof fetch;
  /** Used by the test checkout page to deliver its signed webhook. Defaults to an in-process call. */
  deliverTestWebhook?: (rawBody: string, signature: string) => Promise<void>;
}

export interface StoreApp {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  publishing: ReturnType<typeof createPublishing>;
  sessions: SessionStore;
  ledger: PaymentLedger;
  deps: AppDeps;
}

const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function createStoreApp(deps: AppDeps): StoreApp {
  const { cfg, db, registry, connect, authority, now } = deps;
  const sessions = new SessionStore(db, cfg, connect, now);
  const ledger = new PaymentLedger(db, registry, authority, now, deps.outbox ?? null);
  const paymentsReady = cfg.paymentProvider !== "none" && ledger.canFulfil && !!connect;
  const accessDeps: AccessDeps = { cfg, registry, authority, sessions, paymentsReady };
  const staticRoot = cfg.staticDir ? resolve(cfg.staticDir) : "";

  const currentSession = (req: IncomingMessage): Session | null => sessions.fromCookie(parseCookies(req)[sessions.cookieName]);

  /** Session re-confirmed with HCG Connect when stale. "unavailable" is never treated as signed out or denied. */
  async function freshSession(req: IncomingMessage): Promise<{ session: Session | null; unavailable: boolean; ended: boolean }> {
    const s = currentSession(req);
    if (!s) return { session: null, unavailable: false, ended: false };
    const f = await sessions.ensureFresh(s);
    if (f.status === "ok") return { session: f.session, unavailable: false, ended: false };
    if (f.status === "ended") return { session: null, unavailable: false, ended: true };
    return { session: null, unavailable: true, ended: false };
  }

  function requireConnect(): HcgConnectClient {
    if (!connect) throw new HttpError(503, "hcg_connect_not_configured", "HCG Connect sign-in is not configured for this Store.");
    return connect;
  }

  // ---------------------------------------------------------------- auth

  /** Starts sign-in. `purpose` lets the Sileo flow reuse the same, single HCG Connect login. */
  function startLogin(res: ServerResponse, returnTo: string, purpose: "web" | "sileo", purposeData: string | null) {
    const c = requireConnect();
    const state = randomToken(24);
    const verifier = randomToken(48);
    const nonce = randomToken(24);
    db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`).run(now() - LOGIN_ATTEMPT_TTL_MS);
    db.prepare(`INSERT INTO login_attempts (state, verifier, nonce, return_to, purpose, purpose_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      state,
      verifier,
      nonce,
      returnTo,
      purpose,
      purposeData,
      now(),
    );
    recordAuthEvent(db, now(), "login_started", { detail: { purpose, pkce: "S256", redirectUri: cfg.hcgConnect!.redirectUri } });
    redirect(res, c.authorizationUrl({ state, nonce, codeChallenge: pkceChallenge(verifier) }));
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const c = requireConnect();
    const state = url.searchParams.get("state") ?? "";
    const attempt = db.prepare(`SELECT * FROM login_attempts WHERE state = ?`).get(state) as
      | { state: string; verifier: string; nonce: string; return_to: string; purpose: string; purpose_data: string | null; created_at: number }
      | undefined;
    if (attempt) db.prepare(`DELETE FROM login_attempts WHERE state = ?`).run(state);
    const reject = (reason: string, extra: Record<string, unknown> = {}) => recordAuthEvent(db, now(), "login_rejected", { detail: { reason, ...extra } });
    if (!attempt || now() - attempt.created_at > LOGIN_ATTEMPT_TTL_MS) {
      reject(attempt ? "state_expired" : "state_unknown_or_already_used");
      return authErrorPage(res, "This sign-in link has expired or was already used. Start again from HCG Store.");
    }
    const err = url.searchParams.get("error");
    if (err) {
      reject("provider_error", { error: err.replace(/[^a-z0-9_]/gi, "").slice(0, 60) });
      return authErrorPage(res, err === "access_denied" ? "Sign-in was cancelled. Nothing was changed." : "HCG Connect did not complete the sign-in.");
    }
    const code = url.searchParams.get("code");
    if (!code) {
      reject("missing_code");
      return authErrorPage(res, "HCG Connect did not return a sign-in code.");
    }
    let result;
    try {
      result = await c.exchangeCode(code, attempt.verifier, attempt.nonce);
    } catch (e) {
      // Our own error messages name the failing check (never a token or code).
      reject("exchange_or_verification_failed", { check: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
      return authErrorPage(res, "The sign-in could not be verified. Nothing was changed; please try again.");
    }
    // Confirm the account with HCG's Ecosystem API (/me). A different account is refused outright;
    // an unreachable /me leaves the sign-in valid but unconfirmed.
    let account: "matched" | "unavailable" | "not-configured" = "not-configured";
    if (cfg.ecosystem) {
      const me = await fetchMe(cfg.ecosystem.baseUrl, result.tokens.accessToken, deps.ecosystemFetch);
      if (me.status === "ok" && me.userId !== result.identity.sub) {
        reject("account_mismatch_with_me");
        return authErrorPage(res, "HCG reported a different account for this sign-in. Nothing was changed.");
      }
      account = me.status === "ok" ? "matched" : "unavailable";
    }
    // Replace any existing session in this browser.
    const existing = currentSession(req);
    if (existing) sessions.end(existing.idHash, "replaced");
    const { id, session } = sessions.create(result.identity, result.tokens, account === "matched" ? now() : null);
    recordAuthEvent(db, now(), "login_succeeded", {
      sessionHash: session.idHash,
      sub: session.sub,
      detail: { purpose: attempt.purpose, callback: cfg.hcgConnect!.redirectUri, idTokenVerified: true, accessTokenVerified: true, accountWithMe: account },
    });
    const setCookie = sessions.cookie(id, cfg.sessionAbsoluteSeconds);
    if (attempt.purpose === "sileo") {
      // The Sileo flow finishes on its own page; the browser session is not kept for it.
      return handleSileo.completeLogin(sileoCtx, res, session, attempt.purpose_data);
    }
    redirect(res, safeReturnTo(attempt.return_to), { "set-cookie": setCookie });
  }

  function authErrorPage(res: ServerResponse, message: string) {
    html(
      res,
      400,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign-in · HCG Store</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#05070c;color:#e6ebf2;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem}a{color:#5fe1f0}</style></head>
<body><main><h1>Sign-in not completed</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to HCG Store</a></p></main></body></html>`,
    );
  }

  // ---------------------------------------------------------------- shared helpers

  function sessionJson(s: Session | null) {
    return {
      configured: !!connect,
      signedIn: !!s,
      user: s ? { sub: s.sub, email: s.email, name: s.name } : null,
      /** How HCG Store presents this account (profiles.ts). Presentation only: it grants nothing. */
      profile: s ? getProfile(db, s.sub) : null,
      /** Sign-in confirmed this account with HCG's /me. */
      hcgAccountConfirmed: !!s?.accountConfirmedAt,
    };
  }

  function productEditionFromQuery(id: string, url: URL) {
    const product = findProduct(registry, id);
    if (!product) throw new HttpError(404, "not_found", "Unknown product.");
    const edition = url.searchParams.get("edition");
    if (edition !== null && !validEdition(product, edition)) throw new HttpError(404, "not_found", "Unknown edition.");
    return { product, editions: edition !== null ? [edition] : editionIdsOf(product) };
  }

  function repoCors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (origin && cfg.repoOrigins.includes(origin)) {
      return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "GET", vary: "Origin, Cookie" };
    }
    return {};
  }

  async function library(session: Session) {
    const owned: { productId: string; slug: string; name: string; editionId: string | null; editionName: string | null; state: string }[] = [];
    let unavailable = false;
    for (const product of registry.catalogue.products) {
      if (!product.registry.centralId) continue;
      for (const editionId of editionIdsOf(product)) {
        const a = await decideAccess(accessDeps, product, editionId, session);
        if (a.state === "unavailable") unavailable = true;
        if (a.owned) {
          owned.push({
            productId: product.id,
            slug: product.slug,
            name: product.name,
            editionId,
            editionName: product.editions.find((e) => e.id === editionId)?.name ?? null,
            state: a.downloadsAvailable ? "downloads-available" : "downloads-not-available",
          });
        }
      }
    }
    const purchases = ledger.purchasesFor(session.sub).map((p) => {
      const offer = registry.offers.find((o) => o.id === p.offer_id);
      return {
        id: p.id,
        offerId: p.offer_id,
        title: offer?.title ?? p.offer_id,
        productId: offer?.productId ?? null,
        editionId: offer?.editionId ?? null,
        amount: p.amount,
        currency: p.currency,
        kind: p.kind,
        status: p.status,
        currentPeriodEnd: p.current_period_end,
        createdAt: p.created_at,
        testOnly: offer?.testOnly ?? false,
      };
    });
    return { owned, purchases, ownershipUnavailable: unavailable, downloadsMessage: cfg.protectedDownloads ? null : DOWNLOADS_NOT_AVAILABLE };
  }

  // ---------------------------------------------------------------- downloads

  async function download(req: IncomingMessage, res: ServerResponse, artifactId: string) {
    // Order matters: never reveal anything about a file to someone who may not have it.
    const fresh = await freshSession(req);
    if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "Your access could not be checked right now. Try again shortly.");
    if (!fresh.session) return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect to download.");
    if (!cfg.protectedDownloads) return errorJson(res, 403, "downloads_not_available", DOWNLOADS_NOT_AVAILABLE);
    const artifact = findArtifact(registry, artifactId);
    const product = artifact ? findProduct(registry, artifact.productId) : undefined;
    if (!artifact || !product) return errorJson(res, 404, "not_found", "Not found.");
    const access = await decideAccess(accessDeps, product, artifact.editionId, fresh.session);
    if (access.state === "unavailable") return errorJson(res, 503, "hcg_unavailable", "Your access could not be checked right now. Try again shortly.");
    if (!access.owned && access.state !== "free") return errorJson(res, 403, "not_entitled", "Your HCG account does not include this product.");
    if (!mayDownload(access, artifact.id)) {
      return errorJson(res, 403, "not_released", "This file is not approved for delivery.");
    }
    return streamArtifact(res, artifact.storageKey, artifact.fileName, artifact.contentType);
  }

  function streamArtifact(res: ServerResponse, storageKey: string, fileName: string, contentType: string) {
    const root = resolve(cfg.artifactStorageDir);
    const file = resolve(root, storageKey);
    if (!file.startsWith(root + sep) || !existsSync(file)) return errorJson(res, 404, "not_found", "File not found in private storage.");
    const size = statSync(file).size;
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(size),
      "content-disposition": `attachment; filename="${fileName.replace(/["\\]/g, "_")}"`,
      "cache-control": "private, no-store, max-age=0",
      vary: "Cookie, Authorization",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- checkout

  async function checkout(req: IncomingMessage, res: ServerResponse) {
    assertSameOrigin(req, cfg.publicOrigin);
    const body = await readJson<{ offerId?: unknown }>(req);
    const fresh = await freshSession(req);
    if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "HCG Connect could not be reached. Nothing was charged.");
    if (!fresh.session) return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect before buying.");
    if (!paymentsReady) return errorJson(res, 403, "checkout_not_available", "Checkout is not available yet.");
    const offer = registry.offers.find((o) => o.id === body.offerId && o.status === "approved-for-sale");
    if (!offer) return errorJson(res, 404, "offer_not_found", "This product is not for sale.");
    const product = findProduct(registry, offer.productId)!;
    const access = await decideAccess(accessDeps, product, offer.editionId, fresh.session);
    if (access.state === "unavailable") return errorJson(res, 503, "hcg_unavailable", "Your access could not be checked. Nothing was charged.");
    if (access.owned) return errorJson(res, 409, "already_owned", "Your HCG account already includes this product.");
    const chk = ledger.createCheckout(fresh.session.sub, offer, cfg.paymentProvider);
    // Only the TEST provider exists; its hosted page is served by this server in test mode.
    json(res, 201, { checkoutId: chk.id, redirectUrl: `/test-checkout/${chk.id}`, testMode: true });
  }

  async function testCheckoutPage(req: IncomingMessage, res: ServerResponse, id: string) {
    if (cfg.paymentProvider !== "test") return errorJson(res, 404, "not_found", "Not found.");
    const chk = ledger.checkout(id);
    const s = currentSession(req);
    if (!chk || !s || s.sub !== chk.sub) return errorJson(res, 404, "not_found", "Not found.");
    const offer = registry.offers.find((o) => o.id === chk.offerId)!;
    const price = `${(chk.amount / 100).toFixed(2)} ${chk.currency}`;
    if (req.method === "POST") {
      assertSameOrigin(req, cfg.publicOrigin);
      const body = await readJson<{ outcome?: string }>(req);
      const map: Record<string, PaymentEventType> = { pay: "checkout.completed", fail: "checkout.failed", pending: "checkout.pending" };
      const type = map[body.outcome ?? ""];
      if (!type) return errorJson(res, 400, "bad_outcome", "Unknown outcome.");
      {
        const event = {
          id: `evt_${randomToken(12)}`,
          type,
          checkoutId: chk.id,
          paymentId: `pay_test_${chk.id}`,
          amount: chk.amount,
          currency: chk.currency,
          ...(offer.kind === "subscription" ? { periodEnd: now() + (offer.interval === "year" ? 365 : 30) * 86400_000 } : {}),
        };
        const raw = JSON.stringify(event);
        const sig = signTestEvent(cfg.testPaymentWebhookSecret!, raw, now());
        // The provider's webhook is the only thing that can grant access. The redirect below cannot.
        if (deps.deliverTestWebhook) await deps.deliverTestWebhook(raw, sig);
        else applyTestWebhook(raw, sig);
      }
      return redirect(res, `/checkout/return?checkout=${encodeURIComponent(chk.id)}`);
    }
    html(
      res,
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>TEST checkout · HCG Store</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#05070c;color:#e6ebf2;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;padding:2rem;border:1px solid #2a3442;border-radius:16px;background:#0b1018}.banner{background:#5a3b00;color:#ffd58a;padding:.5rem .75rem;border-radius:8px;font-weight:600}button{font:inherit;margin:.25rem .5rem .25rem 0;padding:.6rem 1rem;border-radius:10px;border:1px solid #3b4757;background:#141b26;color:#e6ebf2;cursor:pointer}button[value=pay]{background:#0e3b42;border-color:#2fd3e6}</style></head>
<body><main><p class="banner">TEST MODE — no real payment is taken and no card details are requested.</p>
<h1>${escapeHtml(offer.title)}</h1><p>Price: <strong>${escapeHtml(price)}</strong>${offer.kind === "subscription" ? ` per ${escapeHtml(offer.interval ?? "")}` : ""}</p>
<p>Choose what the simulated payment provider should report. Access is granted only when the provider's signed event confirms a completed payment.</p>
<form method="post"><button name="outcome" value="pay">Simulate successful payment</button><button name="outcome" value="fail">Simulate failed payment</button><button name="outcome" value="pending">Simulate pending payment</button></form>
</main></body></html>`,
      // "same-origin" (not "no-referrer") so the browser sends this page's Origin with the form POST,
      // which the CSRF check requires.
      { "referrer-policy": "same-origin" },
    );
  }

  function applyTestWebhook(raw: string, signature: string | undefined) {
    const event = verifyTestEvent(cfg.testPaymentWebhookSecret ?? "", raw, signature, now());
    if (!event) throw new HttpError(400, "invalid_signature", "Event signature could not be verified.");
    const outcome = ledger.apply("test", event);
    // Report the change to HCG right away; failures stay in the outbox and are retried.
    if (outcome === "processed") void deps.outbox?.deliver().catch(() => undefined);
    return outcome;
  }

  // ---------------------------------------------------------------- static app

  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
  };
  const staticHeaders: Record<string, string> = {};
  if (staticRoot && existsSync(join(staticRoot, "_headers"))) {
    // Reuse the security headers generated at build time for the static host.
    for (const line of readFileSync(join(staticRoot, "_headers"), "utf8").split("\n")) {
      const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
      if (m) staticHeaders[m[1]!.toLowerCase()] = m[2]!;
    }
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!staticRoot) return errorJson(res, 404, "not_found", "Not found.");
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = resolve(staticRoot, "." + rel);
    if (!file.startsWith(staticRoot + sep)) return errorJson(res, 404, "not_found", "Not found.");
    if (!existsSync(file) || !statSync(file).isFile()) file = join(staticRoot, "index.html"); // SPA fallback
    const ext = extname(file);
    const immutable = rel.startsWith("/assets/");
    res.writeHead(200, {
      ...staticHeaders,
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- router

  const sileoCtx = { cfg, db, registry, sessions, connect, authority, accessDeps, now, startLogin, streamArtifact, freshSession };
  const publishing = createPublishing({ cfg, db, registry, connect, authority, now, freshSession, streamArtifact });
  if (cfg.publishing.enabled) registry.published = publishing;

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://store.invalid");
    const p = url.pathname;
    const m = req.method ?? "GET";
    let match: RegExpExecArray | null;

    if (p === "/api/v1/health" && m === "GET") {
      return json(res, 200, {
        status: "ok",
        mode: cfg.mode,
        hcgConnect: connect ? "configured" : "not-configured",
        entitlementAuthority: authority.kind,
        payments: cfg.paymentProvider === "none" ? "disabled" : `${cfg.paymentProvider}-mode`,
        protectedDownloads: cfg.protectedDownloads ? "enabled" : "disabled",
      });
    }
    if (p === "/api/v1/session" && m === "GET") {
      const fresh = await freshSession(req);
      const headers: Record<string, string> = fresh.ended ? { "set-cookie": sessions.clearCookie() } : {};
      if (fresh.unavailable) {
        const s = currentSession(req);
        return json(res, 200, { ...sessionJson(s), centralCheck: "unavailable" }, headers);
      }
      return json(res, 200, { ...sessionJson(fresh.session), ...(fresh.ended ? { endedReason: "Your HCG session has ended. Sign in again." } : {}) }, headers);
    }
    if (p === "/auth/login" && m === "GET") return startLogin(res, safeReturnTo(url.searchParams.get("return_to")), "web", null);
    if (p === "/auth/callback" && m === "GET") return callback(req, res, url);
    if (p === "/auth/logout" && m === "POST") {
      assertSameOrigin(req, cfg.publicOrigin);
      const s = currentSession(req);
      if (s) sessions.end(s.idHash, "logout");
      return json(res, 200, { signedIn: false }, { "set-cookie": sessions.clearCookie() });
    }
    if (p === "/api/v1/offers" && m === "GET") {
      return json(res, 200, {
        checkoutAvailable: paymentsReady,
        testMode: cfg.paymentProvider === "test",
        offers: registry.offers.filter((o) => o.status === "approved-for-sale").map((o) => ({ ...accessOffer(o), productId: o.productId, editionId: o.editionId })),
      });
    }
    if ((match = /^\/api\/v1\/products\/([a-z0-9-]+)\/access$/.exec(p)) && m === "GET") {
      const { product, editions } = productEditionFromQuery(match[1]!, url);
      const fresh = await freshSession(req);
      const results = [];
      for (const e of editions) results.push(await decideAccess(accessDeps, product, e, fresh.session, fresh.unavailable));
      const headers: Record<string, string> = fresh.ended ? { "set-cookie": sessions.clearCookie() } : {};
      return json(res, 200, { productId: product.id, signedIn: !!fresh.session, editions: results }, headers);
    }
    if (p === "/api/v1/checkout" && m === "POST") return checkout(req, res);
    if ((match = /^\/api\/v1\/checkout\/(chk_[A-Za-z0-9_-]+)$/.exec(p)) && m === "GET") {
      const s = currentSession(req);
      const chk = ledger.checkout(match[1]!);
      if (!s || !chk || chk.sub !== s.sub) return errorJson(res, 404, "not_found", "Not found.");
      const offer = registry.offers.find((o) => o.id === chk.offerId);
      return json(res, 200, { id: chk.id, status: chk.status, productId: offer?.productId ?? null, editionId: offer?.editionId ?? null, title: offer?.title ?? null });
    }
    if ((match = /^\/test-checkout\/(chk_[A-Za-z0-9_-]+)$/.exec(p)) && (m === "GET" || m === "POST")) return testCheckoutPage(req, res, match[1]!);
    if (p === "/api/v1/payments/webhook/test" && m === "POST") {
      if (cfg.paymentProvider !== "test") return errorJson(res, 404, "not_found", "Not found.");
      const raw = await readBody(req);
      const outcome = applyTestWebhook(raw, req.headers[TEST_SIGNATURE_HEADER] as string | undefined);
      return json(res, 200, { received: true, outcome });
    }
    if (p === "/api/v1/library" && m === "GET") {
      const fresh = await freshSession(req);
      if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "Your library could not be loaded right now. Try again shortly.");
      if (!fresh.session) {
        return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect to see your library.", fresh.ended ? { "set-cookie": sessions.clearCookie() } : {});
      }
      return json(res, 200, await library(fresh.session));
    }
    if ((match = /^\/api\/v1\/downloads\/([a-z0-9-]+)$/.exec(p)) && m === "GET") return download(req, res, match[1]!);
    if ((match = /^\/api\/v1\/repo\/products\/([a-z0-9-]+)\/access$/.exec(p)) && (m === "GET" || m === "OPTIONS")) {
      const cors = repoCors(req);
      if (m === "OPTIONS") return send(res, 204, "", cors);
      const mapped = findByRepoKey(registry, match[1]!);
      if (!mapped) return errorJson(res, 404, "not_found", "Unknown HCG Repo product.", cors);
      const fresh = await freshSession(req);
      const a = await decideAccess(accessDeps, mapped.product, mapped.editionId, fresh.session, fresh.unavailable);
      const storePath = `/apps/${mapped.product.slug}${mapped.editionId ? `?edition=${encodeURIComponent(mapped.editionId)}` : ""}`;
      return json(
        res,
        200,
        {
          state: a.state,
          store_url: cfg.publicOrigin + storePath,
          ...(a.state === "not-owned" ? { buy_url: cfg.publicOrigin + storePath + (storePath.includes("?") ? "&" : "?") + "buy=1" } : {}),
          downloads_available: a.downloadsAvailable,
          message: a.state === "owned" && !a.downloadsAvailable ? DOWNLOADS_NOT_AVAILABLE : a.message,
        },
        cors,
      );
    }
    if (await publishing.route(req, res, url)) return;
    if (p.startsWith("/repo-api/v1/sileo/")) return handleSileo.route(sileoCtx, req, res, url);
    if ((match = /^\/repo-api\/v1\/files\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(p)) && m === "GET") return handleSileo.serveFile(sileoCtx, res, match[1]!);
    if (p.startsWith("/api/") || p.startsWith("/auth/") || p.startsWith("/repo-api/")) return errorJson(res, 404, "not_found", "Not found.");
    if (m === "GET" || m === "HEAD") return serveStatic(req, res, p);
    return errorJson(res, 405, "method_not_allowed", "Method not allowed.");
  }

  function accessOffer(o: (typeof registry.offers)[number]) {
    return { id: o.id, title: o.title, kind: o.kind, interval: o.interval, currency: o.currency, unitAmount: o.unitAmount, grants: o.grants.map((g) => g.edition), testOnly: o.testOnly };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      await route(req, res);
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return errorJson(res, e.status, e.code, e.message);
      console.error("HCG Store server error:", e instanceof Error ? e.message : e);
      errorJson(res, 500, "server_error", "Something went wrong. Nothing was changed.");
    }
  }

  return { handle, sessions, ledger, deps, publishing };
}

export function listen(app: StoreApp, port: number, host: string) {
  const server = createServer((req, res) => void app.handle(req, res));
  return new Promise<ReturnType<typeof createServer>>((ok) => server.listen(port, host, () => ok(server)));
}
