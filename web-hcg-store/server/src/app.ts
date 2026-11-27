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
 *   GET  /api/public/v1/release-resolution/:product   current approved release and how to get it (public, CORS; no URLs to files)
 *   GET  /api/public/v1/published                      every product's currently published releases (public, CORS; metadata only)
 *   /api/sileo/v1/*                            Sileo / Zebra payment provider (sileo.ts); /repo-api/v1/sileo/* is an alias
 *   GET  /api/v1/account/package-managers      the account's Sileo / Zebra connections
 *   POST /api/v1/account/package-managers/:ref/revoke · /revoke-all
 *   GET  /api/v1/account/receipts/:purchaseId  a purchase receipt (the account's own)
 *   /api/v1/commerce/*, /api/v1/repo/packages  commerce administration and the HCG Repo package contract (commerce-admin.ts)
 */
import { resolveRelease, ResolutionError } from "./release-resolution";
import { productHead, withProductHead } from "./product-head";
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
import { currentReleaseOf, findArtifact, findByRepoKey, findProduct, type ProtectedArtifact, type Registry } from "./registry";
import { getProfile } from "./profiles";
import { createPublishing } from "./publishing";
import { SessionStore, type Session } from "./sessions";
import { completePackageManagerLogin, LEGACY_SILEO_BASE, packageManagersOf, revokePackageManager, SILEO_BASE, sileoRoute, type SileoCtx } from "./sileo";
import { Commerce, majorOf } from "./commerce";
import { commerceAdminRoute } from "./commerce-admin";
import type { CheckoutSession } from "./payments";

/** HCG's account portal, where an account's HCG licences are managed (main-site handoff, /features links.account). */
const HCG_ACCOUNT_URL = "https://beta.hakmicapitalgroup.com/client-portal";

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
  commerce: Commerce;
  deps: AppDeps;
}

const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function createStoreApp(deps: AppDeps): StoreApp {
  const { cfg, db, registry, connect, authority, now } = deps;
  const sessions = new SessionStore(db, cfg, connect, now);
  const ledger = new PaymentLedger(db, registry, authority, now, deps.outbox ?? null);
  const paymentsReady = cfg.paymentProvider !== "none" && ledger.canFulfil && !!connect;
  const accessDeps: AccessDeps = { cfg, registry, authority, sessions, paymentsReady };
  const commerce = new Commerce(db, cfg, registry, now);
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
    let identity = result.identity;
    if (cfg.ecosystem) {
      const me = await fetchMe(cfg.ecosystem.baseUrl, result.tokens.accessToken, deps.ecosystemFetch);
      if (me.status === "ok" && me.userId !== result.identity.sub) {
        reject("account_mismatch_with_me");
        return authErrorPage(res, "HCG reported a different account for this sign-in. Nothing was changed.");
      }
      account = me.status === "ok" ? "matched" : "unavailable";
      // HCG's account display name (central profile) when HCG has one for this exact, matched account.
      if (me.status === "ok" && me.displayName) identity = { ...identity, name: me.displayName };
    }
    // Replace any existing session in this browser.
    const existing = currentSession(req);
    if (existing) sessions.end(existing.idHash, "replaced");
    const { id, session } = sessions.create(identity, result.tokens, account === "matched" ? now() : null);
    recordAuthEvent(db, now(), "login_succeeded", {
      sessionHash: session.idHash,
      sub: session.sub,
      detail: { purpose: attempt.purpose, callback: cfg.hcgConnect!.redirectUri, idTokenVerified: true, accessTokenVerified: true, accountWithMe: account },
    });
    const setCookie = sessions.cookie(id, cfg.sessionAbsoluteSeconds);
    if (attempt.purpose === "sileo") {
      // The package-manager flow ends at its sileo:// callback; no browser cookie is set for it.
      return completePackageManagerLogin(sileoCtx, res, session, attempt.purpose_data);
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

  /**
   * "My HCG apps": every HCG product registered for this account (for the Founder, HCG's whole registry), with what
   * HCG's /access reports per product: ownership kind, entitlement source, editions and features. HCG's release
   * status and the Store's own release availability are reported separately. Display only: every download and every
   * other protected action is still decided by HCG's /check at the moment it is requested.
   */
  async function myApps(session: Session) {
    const known = registry.catalogue.products.filter((p) => !p.supersededBy && p.visibility !== "draft");
    const candidates = known.map((p) => p.registry.centralId).filter((c): c is string => !!c);
    const acc = await authority.accountAccess({ sub: session.sub, accessToken: session.accessToken }, candidates);
    const purchasedOffers = new Set(ledger.purchasesFor(session.sub).filter((p) => p.status === "active").map((p) => p.offer_id));
    const purchasedProducts = new Set(registry.offers.filter((o) => purchasedOffers.has(o.id)).map((o) => o.productId));
    const SOURCE: Record<string, string> = {
      founder_owner_all_products: "Founder / Owner grant",
      organisation_license: "Organisation licence",
      personal_operational_grant: "Personal grant",
      app_access: "App access",
      security_baseline: "Included for every HCG account",
    };
    const storeOf = (central: string) => known.find((p) => p.registry.centralId === central) ?? null;
    const apps: MyAppView[] = [];
    if (acc.status === "ok") {
      for (const pa of acc.products) {
        const product = storeOf(pa.centralProductId);
        const state = pa.kind === "founder_owner" ? "owner" : pa.kind === "organisation_license" ? "licensed" : pa.kind;
        const source = pa.kind === "founder_owner" ? SOURCE[pa.entitlementSource ?? ""] ?? null
          : pa.kind === "organisation_license" ? (product && purchasedProducts.has(product.id) ? "Purchased in HCG Store" : SOURCE.organisation_license!) : null;
        const editionNames = pa.editions === "all" ? "all" as const
          : pa.editions.map((k) => product?.editions.find((e) => e.centralEditionKey === k)?.name ?? k);
        apps.push(view(product, pa.centralProductId, pa.name ?? product?.name ?? pa.centralProductId, pa.releaseStatus, state, source, editionNames,
          pa.features.filter((f) => f.enabled && f.allowed).map((f) => f.key), pa.features.filter((f) => !(f.enabled && f.allowed)).length));
      }
    } else {
      for (const product of known.filter((p) => p.registry.centralId)) apps.push(view(product, product.registry.centralId, product.name, null, "unknown", null, [], [], 0));
    }
    for (const product of known.filter((p) => !p.registry.centralId)) apps.push(view(product, null, product.name, null, "not-registered", null, [], [], 0));
    const rank = { owner: 0, licensed: 0, none: 1, unknown: 1, "not-registered": 2 } as const;
    apps.sort((a, b) => rank[a.access.state] - rank[b.access.state] || Number(!a.storeProductId) - Number(!b.storeProductId) || a.name.localeCompare(b.name));
    const ownerAccess = acc.status === "ok" && acc.founderPolicy ? { label: "Owner access — All features", source: "Founder / Owner grant" } : null;
    // Token-free evidence for verification: counts only, no product list, no account ID.
    recordAuthEvent(db, now(), "my_apps_viewed", {
      sessionHash: session.idHash,
      detail: {
        central: acc.status,
        founderPolicy: !!ownerAccess,
        products: apps.length,
        owner: apps.filter((a) => a.access.state === "owner").length,
        licensed: apps.filter((a) => a.access.state === "licensed").length,
        none: apps.filter((a) => a.access.state === "none").length,
        unknown: apps.filter((a) => a.access.state === "unknown").length,
        notRegistered: apps.filter((a) => a.access.state === "not-registered").length,
        sources: [...new Set(apps.map((a) => a.access.source).filter(Boolean))],
      },
    });
    return { centralStatus: acc.status, displayName: acc.status === "ok" ? acc.displayName : null, ownerAccess, apps };
  }

  type MyAppView = {
    centralProductId: string | null;
    name: string;
    storeProductId: string | null;
    slug: string | null;
    hcgReleaseStatus: string | null;
    storeRelease: "released" | "not-released" | "not-in-store";
    access: { state: "owner" | "licensed" | "none" | "unknown" | "not-registered"; source: string | null; editions: "all" | string[]; features: { available: string[]; notAvailable: number } };
    download: "available" | "not-released" | "not-in-store" | "not-registered" | "not-available" | "not-entitled";
    manage: string | null;
  };

  function view(
    product: (typeof registry.catalogue.products)[number] | null, central: string | null, name: string, hcgReleaseStatus: string | null,
    state: MyAppView["access"]["state"], source: string | null, editions: "all" | string[], available: string[], notAvailable: number,
  ): MyAppView {
    const released = product ? !!currentReleaseOf(registry.catalogue, product) : false;
    const entitled = state === "owner" || state === "licensed";
    const download: MyAppView["download"] = !product ? "not-in-store" : !released ? "not-released" : !central ? "not-registered" : !cfg.protectedDownloads ? "not-available" : entitled ? "available" : "not-entitled";
    return {
      centralProductId: central, name, storeProductId: product?.id ?? null, slug: product?.slug ?? null, hcgReleaseStatus,
      storeRelease: !product ? "not-in-store" : released ? "released" : "not-released",
      access: { state, source, editions, features: { available, notAvailable } },
      download, manage: entitled ? HCG_ACCOUNT_URL : null,
    };
  }

  /**
   * My Library: what the account holds (licensed by HCG, or free with an HCG account), each edition's explicit current
   * release from the catalogue, its HCG Repo link, subscriptions, purchases, invoices (none exist yet) and the Sileo
   * connections made with this account. Nothing here says an app is installed: the Store has no device evidence.
   */
  async function library(session: Session) {
    type Entry = {
      productId: string; slug: string; name: string; editionId: string | null; editionName: string | null; state: string;
      acquisition: "licensed" | "free"; licence: string; tier: string | null; pricingModel: string;
      currentRelease: { id: string; version: string; channel: string; releaseDate: string | null } | null;
      hcgRepoKey: string | null; channel: string | null;
    };
    const owned: Entry[] = [];
    let unavailable = false;
    for (const product of registry.catalogue.products) {
      if (product.visibility === "draft") continue;
      for (const editionId of editionIdsOf(product)) {
        if (!product.registry.centralId && !(registry.published?.freePublicFor(product.id, editionId) ?? []).length) continue;
        const a = await decideAccess(accessDeps, product, editionId, session);
        if (a.state === "unavailable") unavailable = true;
        if (!a.owned && a.state !== "free") continue;
        const edition = product.editions.find((e) => e.id === editionId) ?? null;
        const rel = product.currentReleaseId ? registry.catalogue.releases.find((r) => r.id === product.currentReleaseId && r.status === "approved") : undefined;
        owned.push({
          productId: product.id,
          slug: product.slug,
          name: product.name,
          editionId,
          editionName: edition?.name ?? null,
          state: a.downloadsAvailable ? "downloads-available" : "downloads-not-available",
          acquisition: a.owned ? "licensed" : "free",
          licence: a.owned ? "Active HCG licence" : "Free with your HCG account",
          tier: edition?.tier ?? null,
          pricingModel: edition?.pricingModel ?? "not-set",
          currentRelease: rel ? { id: rel.id, version: rel.version, channel: rel.channel, releaseDate: rel.releaseDate } : null,
          hcgRepoKey: product.hcgRepo.find((l) => l.editionId === editionId || (l.editionId === null && product.editions.length <= 1))?.key ?? null,
          channel: edition?.channel ?? null,
        });
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
        updatedAt: p.updated_at,
        testOnly: offer?.testOnly ?? false,
        /** Where the purchase was made: the Store website or a package manager (Sileo, Zebra). One history for both. */
        channel: p.channel === "package-manager" ? "package-manager" : "web",
        receiptNumber: p.id,
        refund: p.status === "refunded" ? "refunded" : p.status === "disputed" ? "disputed" : "none",
        versionAtPurchase: p.version_at_purchase,
      };
    });
    const packageManagers = packageManagersOf(sileoCtx, session.sub);
    const devices = packageManagers
      .filter((d) => d.status === "active")
      .map((d) => ({ kind: "sileo", label: `${d.client} (HCG Repo)${d.deviceModel ? ` on ${d.deviceModel}` : ""}`, connectedAt: d.connectedAt, ref: d.ref, deviceModel: d.deviceModel, lastUsedAt: d.lastUsedAt }));
    // Repository packages the account may download, with the newest approved version it is eligible for. HCG Store does
    // not know what is installed on a device, so this is "available to your account", never "installed".
    const packageUpdates = [] as { packageId: string; productId: string; editionId: string | null; name: string; latestVersion: string; eligible: boolean; policy: string }[];
    for (const c of commerce.channels().filter((x) => x.status === "active" && x.access !== "free")) {
      const product = findProduct(registry, c.productId);
      const entry = product && owned.find((o) => o.productId === product.id && o.editionId === c.editionId);
      if (!product || !entry) continue;
      const rel = currentReleaseOf(registry.catalogue, product);
      const latest = rel?.version ?? registry.published?.publishedFor(product.id, c.editionId).map((f) => registry.published?.publishedMeta(f.id)?.version).find(Boolean) ?? null;
      if (!latest) continue;
      const bought = purchases.filter((x) => x.productId === product.id && x.editionId === c.editionId && x.refund === "none" && x.versionAtPurchase);
      const eligible = c.updatePolicy === "all-updates" || !bought.length || bought.some((x) => majorOf(x.versionAtPurchase!) === majorOf(latest));
      packageUpdates.push({ packageId: c.packageId, productId: product.id, editionId: c.editionId, name: `${product.name}${entry.editionName ? ` ${entry.editionName}` : ""}`, latestVersion: latest, eligible, policy: c.updatePolicy });
    }
    return {
      owned,
      purchases,
      subscriptions: purchases.filter((p) => p.kind === "subscription"),
      invoices: { available: false, items: [] as unknown[], message: "HCG Store has not issued any invoices. Live payments are not switched on." },
      devices,
      packageManagers,
      packageUpdates,
      devicesNote: "A connected package manager is not an installation. HCG Store does not know which apps are installed on your devices, so it shows no install or update status.",
      ownershipUnavailable: unavailable,
      downloadsMessage: cfg.protectedDownloads || cfg.freeDownloads ? null : DOWNLOADS_NOT_AVAILABLE,
    };
  }

  // ---------------------------------------------------------------- account: package managers and receipts

  async function account(req: IncomingMessage, res: ServerResponse, p: string, m: string) {
    const fresh = await freshSession(req);
    if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "Your account could not be loaded right now. Try again shortly.");
    if (!fresh.session) return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect.", fresh.ended ? { "set-cookie": sessions.clearCookie() } : {});
    const s = fresh.session;
    let match: RegExpExecArray | null;
    if (p === "/api/v1/account/package-managers" && m === "GET") return json(res, 200, { packageManagers: packageManagersOf(sileoCtx, s.sub) });
    if ((match = /^\/api\/v1\/account\/package-managers\/(pms_[A-Za-z0-9_-]{6,40})\/revoke$/.exec(p)) && m === "POST") {
      assertSameOrigin(req, cfg.publicOrigin);
      const ok = revokePackageManager(sileoCtx, { ref: match[1]!, sub: s.sub }, "revoked-by-account-holder", s.sub);
      if (!ok) return errorJson(res, 404, "not_found", "This connection is not active.");
      return json(res, 200, { revoked: true, packageManagers: packageManagersOf(sileoCtx, s.sub) });
    }
    if (p === "/api/v1/account/package-managers/revoke-all" && m === "POST") {
      assertSameOrigin(req, cfg.publicOrigin);
      let n = 0;
      for (const d of packageManagersOf(sileoCtx, s.sub).filter((x) => x.status === "active")) if (revokePackageManager(sileoCtx, { ref: d.ref, sub: s.sub }, "revoked-by-account-holder", s.sub)) n++;
      return json(res, 200, { revoked: n, packageManagers: packageManagersOf(sileoCtx, s.sub) });
    }
    if ((match = /^\/api\/v1\/account\/receipts\/(pur_[A-Za-z0-9_-]{10,40})$/.exec(p)) && m === "GET") {
      const pur = ledger.purchasesFor(s.sub).find((x) => x.id === match![1]);
      if (!pur) return errorJson(res, 404, "not_found", "Not found.");
      const offer = registry.offers.find((o) => o.id === pur.offer_id);
      const product = offer ? findProduct(registry, offer.productId) : undefined;
      return json(res, 200, {
        receiptNumber: pur.id,
        issuedBy: "HCG Store (Hakmi Capital Group)",
        testMode: pur.provider === "test" || !!offer?.testOnly,
        note: pur.provider === "test" ? "TEST purchase: no money moved. This is not a tax invoice." : "Purchase confirmation. HCG Store has not issued tax invoices yet.",
        account: { name: s.name, email: s.email },
        item: { title: offer?.title ?? pur.offer_id, product: product?.name ?? null, editionId: offer?.editionId ?? null, kind: pur.kind },
        amount: pur.amount, currency: pur.currency,
        status: pur.status,
        refund: pur.status === "refunded" ? "refunded" : pur.status === "disputed" ? "disputed" : "none",
        channel: pur.channel === "package-manager" ? "package-manager" : "web",
        paymentReference: `${pur.provider}:${pur.provider_payment_id.slice(-8)}`,
        purchasedAt: pur.created_at,
        updatedAt: pur.updated_at,
        currentPeriodEnd: pur.current_period_end,
      });
    }
    return errorJson(res, 404, "not_found", "Not found.");
  }

  // ---------------------------------------------------------------- downloads

  // Downloads without an HCG account: per visitor address, at most this many file requests a minute.
  const ANON_DOWNLOADS_PER_MINUTE = 20;
  const anonWindows = new Map<string, { start: number; n: number }>();
  function anonymousAllowed(req: IncomingMessage): boolean {
    const header = req.headers["fly-client-ip"];
    const ip = (Array.isArray(header) ? header[0] : header) ?? req.socket.remoteAddress ?? "unknown";
    const t = Date.now();
    const w = anonWindows.get(ip);
    if (!w || t - w.start >= 60_000) {
      anonWindows.set(ip, { start: t, n: 1 });
      if (anonWindows.size > 10_000) for (const [k, v] of anonWindows) if (t - v.start >= 60_000) anonWindows.delete(k);
      return true;
    }
    return ++w.n <= ANON_DOWNLOADS_PER_MINUTE;
  }

  /**
   * A free public file of a product approved for downloads without an account: no session needed. Only files that
   * freePublicFor returns right now (published, approved public and free, current, available, verified, free basis
   * open), so withdrawn, revoked, superseded or private files are never served this way.
   */
  function anonymousFreeFile(artifactId: string): ProtectedArtifact | undefined {
    if (!cfg.freeDownloads || !cfg.anonymousFreeProducts.length) return undefined;
    const a = findArtifact(registry, artifactId);
    if (!a || !cfg.anonymousFreeProducts.includes(a.productId)) return undefined;
    return (registry.published?.freePublicFor(a.productId, a.editionId) ?? []).find((x) => x.id === a.id);
  }

  async function download(req: IncomingMessage, res: ServerResponse, artifactId: string) {
    const open = anonymousFreeFile(artifactId);
    if (open) {
      if (!anonymousAllowed(req)) return errorJson(res, 429, "rate_limited", "Too many downloads from your address. Try again in a minute.", { "retry-after": "60" });
      return streamArtifact(res, open.storageKey, open.fileName, open.contentType);
    }
    // Order matters: never reveal anything about a file to someone who may not have it.
    const fresh = await freshSession(req);
    if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "Your access could not be checked right now. Try again shortly.");
    if (!fresh.session) return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect to download.");
    if (!cfg.protectedDownloads && !cfg.freeDownloads) return errorJson(res, 403, "downloads_not_available", DOWNLOADS_NOT_AVAILABLE);
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
      // ASCII fallback plus the exact name (RFC 6266/5987), e.g. "HCG Mail.app.zip".
      "content-disposition": `attachment; filename="${fileName.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
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
      const outcome = body.outcome;
      if (outcome !== "pay" && outcome !== "fail" && outcome !== "pending") return errorJson(res, 400, "bad_outcome", "Unknown outcome.");
      // The provider's webhook is the only thing that can grant access. The redirect below cannot.
      await simulateTestPayment(chk, outcome);
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

  /** The TEST provider reporting an outcome: a signed event delivered to the webhook (in process unless injected). */
  async function simulateTestPayment(chk: CheckoutSession, outcome: "pay" | "fail" | "pending" | "cancel") {
    if (cfg.paymentProvider !== "test") throw new HttpError(404, "not_found", "Not found.");
    const offer = registry.offers.find((o) => o.id === chk.offerId)!;
    const map: Record<typeof outcome, PaymentEventType> = { pay: "checkout.completed", fail: "checkout.failed", pending: "checkout.pending", cancel: "checkout.canceled" };
    const event = {
      id: `evt_${randomToken(12)}`,
      type: map[outcome],
      checkoutId: chk.id,
      paymentId: `pay_test_${chk.id}`,
      amount: chk.amount,
      currency: chk.currency,
      ...(offer.kind === "subscription" ? { periodEnd: now() + (offer.interval === "year" ? 365 : 30) * 86400_000 } : {}),
    };
    const raw = JSON.stringify(event);
    const sig = signTestEvent(cfg.testPaymentWebhookSecret!, raw, now());
    if (deps.deliverTestWebhook) await deps.deliverTestWebhook(raw, sig);
    else applyTestWebhook(raw, sig);
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
    if (!existsSync(file) || !statSync(file).isFile()) {
      file = join(staticRoot, "index.html"); // SPA fallback
      // Product pages: the product's own title, description, social image and SoftwareApplication data in the HTML.
      const slug = /^\/apps\/([a-z0-9-]+)\/?$/.exec(rel)?.[1];
      if (slug) {
        const product = registry.catalogue.products.find((x) => x.slug === slug);
        const live = product && registry.published ? publishing.currentPublishedFor(product.id) : [];
        const head = productHead({ catalogue: registry.catalogue, slug, origin: cfg.publicOrigin, live });
        if (head) {
          const html = withProductHead(readFileSync(file, "utf8"), head);
          res.writeHead(200, { ...staticHeaders, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
          return res.end(req.method === "HEAD" ? undefined : html);
        }
      }
    }
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

  const publishing = createPublishing({ cfg, db, registry, connect, authority, now, freshSession, streamArtifact });
  const sileoCtx: SileoCtx = {
    cfg, db, registry, sessions, accessDeps, ledger, commerce, admin: publishing.admin, now, paymentsReady, startLogin, streamArtifact, simulateTestPayment, hasConnect: !!connect,
  };
  const commerceCtx = { commerce, sileo: sileoCtx, kit: publishing.admin };
  // Customer delivery of published releases only when publication is on (never in "uploads" mode).
  if (cfg.publishing.publicationEnabled) registry.published = publishing;

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
        protectedDownloads: cfg.protectedDownloads ? "enabled" : cfg.freeDownloads ? "free-testing-only" : "disabled",
        anonymousFreeProducts: cfg.anonymousFreeProducts,
        // Ship to Store clients (HCG Executable Maker, HCG Store Manager) read this before signing in.
        publishing: cfg.publishing.mode,
        // Package-manager payment provider: what is in force (the Payment Provider Studio sets it, the server caps it).
        packageManagerProvider: commerce.effective().availability,
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
    if (p === "/api/v1/my-apps" && m === "GET") {
      const fresh = await freshSession(req);
      if (fresh.unavailable) return errorJson(res, 503, "hcg_unavailable", "Your apps could not be loaded right now. Try again shortly.");
      if (!fresh.session) return errorJson(res, 401, "sign_in_required", "Sign in with HCG Connect to see your apps.", fresh.ended ? { "set-cookie": sessions.clearCookie() } : {});
      return json(res, 200, await myApps(fresh.session));
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
    if ((match = /^\/api\/public\/v1\/release-resolution\/([a-z0-9-]+)$/.exec(p)) && (m === "GET" || m === "OPTIONS")) {
      // Public, read-only, no cookies: any website may read it (release-resolution.ts).
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400", vary: "Origin" };
      if (m === "OPTIONS") return send(res, 204, "", cors);
      try {
        const body = resolveRelease({ cfg, registry, live: cfg.publishing.publicationEnabled ? publishing : null, now: now() }, match[1]!, { platform: url.searchParams.get("platform"), arch: url.searchParams.get("arch") });
        return json(res, 200, body, { ...cors, "cache-control": "public, max-age=60" });
      } catch (e) {
        if (e instanceof ResolutionError) return errorJson(res, e.status, e.code, e.message, cors);
        throw e;
      }
    }
    if (p === "/api/public/v1/published" && (m === "GET" || m === "OPTIONS")) {
      // Public, read-only: the releases each catalogue product has CURRENTLY published through HCG Store (per-target
      // current, approved public, available), so pages follow publications without a catalogue edit. Metadata only:
      // no download URL, no account data. Downloads still go through the access checks on /api/v1/downloads.
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400", vary: "Origin" };
      if (m === "OPTIONS") return send(res, 204, "", cors);
      const products: Record<string, unknown[]> = {};
      if (cfg.publishing.publicationEnabled) {
        for (const product of registry.catalogue.products) {
          if (product.visibility === "draft") continue;
          const live = publishing.currentPublishedFor(product.id);
          if (live.length) products[product.id] = live.map(({ targets: _t, ...r }) => r);
        }
      }
      return json(res, 200, { format: "hcg.store.published/1", generatedAt: new Date(now()).toISOString(), products }, { ...cors, "cache-control": "public, max-age=60" });
    }
    if (await publishing.route(req, res, url)) return;
    if (await commerceAdminRoute(commerceCtx, req, res, url)) return;
    if (p.startsWith(SILEO_BASE) || p.startsWith(LEGACY_SILEO_BASE)) return sileoRoute(sileoCtx, req, res, url);
    // The first, signed-URL scheme put account references in the URL; it is retired (single-use grants replace it).
    if (p.startsWith("/repo-api/v1/files/")) return errorJson(res, 410, "gone", "This download link is no longer valid. Start the download again in your package manager.");
    if (p.startsWith("/api/v1/account/")) return account(req, res, p, m);
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

  return { handle, sessions, ledger, commerce, deps, publishing };
}

export function listen(app: StoreApp, port: number, host: string) {
  const server = createServer((req, res) => void app.handle(req, res));
  return new Promise<ReturnType<typeof createServer>>((ok) => server.listen(port, host, () => ok(server)));
}
