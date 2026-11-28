/**
 * HCG Store as the payment provider of HCG Repo for Sileo and Zebra ("Sileo payment provider" protocol, v1).
 *
 * Contract, as the clients implement it (checked against Sileo `c9f7015`, Backend/Payment Manager/*.swift, and Zebra
 * `e2f3c27`, ZBPaymentVendor.m; the documentation sites were unreachable from the build environment):
 * - Discovery: `<repo>/payment_endpoint` holds this base URL (https only). HCG Repo publishes it from
 *   `[access] payment_endpoint`; while the provider is not public that stays empty.
 * - `GET info` → { name, description, icon, authentication_banner: { message, button } }.
 * - `GET authenticate?udid=&model=` opens in ASWebAuthenticationSession; success ends at
 *   `sileo://authentication_success?token=…&payment_secret=…`.
 * - POSTs are JSON. Every body carries `udid` and `device`; most carry `token`; purchases also `payment_secret`.
 * - `user_info` → { items: [package ids], user: { name, email } }.
 * - `package/<id>/info` (POST, or GET from Zebra when signed out; the token is optional) → { price, purchased: 0|1,
 *   available: 0|1 }.
 * - `package/<id>/purchase` → { status: 0 | 1 | -1, url?, error? }; with 1 the client opens `url` and waits for any
 *   `sileo://` callback (we use `sileo://payment_completed`).
 * - `package/<id>/authorize_download` (+ version, repo, architecture) → { url } (https).
 * - `sign_out`.
 * - Errors: { success: false, error, recovery_url?, invalidate? }; `invalidate: true` makes the client forget its token.
 *
 * Security model:
 * - The token and payment secret are HCG Store's own package-manager credentials, never HCG Connect tokens. Only their
 *   SHA-256 is stored. Each is bound to a Store session made by the normal HCG Connect PKCE sign-in, so HCG session
 *   expiry, sign-out from Sileo, and revocation from the HCG Store account page all end it.
 * - The device identifier Sileo sends is never stored: a keyed hash (HMAC with the Store's secret) binds the
 *   credential to the device it was issued to, and only the model name (e.g. iPhone14,2) is kept for the account page.
 * - Purchases never grant anything. They create a server-priced checkout; only the payment provider's verified event
 *   grants the entitlement (payments.ts).
 * - Download URLs are opaque, single-use, short-lived grants bound to one artifact and its SHA-256. They carry no
 *   account data. Using one re-checks the credential, the session, the entitlement and the release.
 * - Nothing here logs a token, secret, code or device identifier.
 */
import { createHmac } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { decideAccess, deliverableArtifacts, mayDownload, DOWNLOADS_NOT_AVAILABLE, type AccessDeps, type EditionAccess } from "./access";
import { majorOf, normalizeRepo, type Channel, type Commerce } from "./commerce";
import type { StoreConfig } from "./config";
import { randomToken, safeEqual, sha256Hex } from "./crypto";
import { transaction, type Db } from "./db";
import { escapeHtml, html, json, readJson, redirect, send } from "./http";
import type { CheckoutSession, PaymentLedger } from "./payments";
import type { Actor } from "./publishing";
import { debianVersionMatches } from "./publishing";
import { currentReleaseOf, findArtifact, findProduct, offersFor, type Offer, type ProtectedArtifact, type Registry } from "./registry";
import type { Session, SessionStore } from "./sessions";
import type { Product } from "../../src/domain/schema";

export const SILEO_BASE = "/api/sileo/v1/";
/** The first path the Store served the protocol on. Kept as an alias so no configured client breaks. */
export const LEGACY_SILEO_BASE = "/repo-api/v1/sileo/";
const CHECKOUT_LINK_TTL_MS = 30 * 60 * 1000;

export interface AdminKit {
  permitted: (actor: Actor, permission: "publish" | "approve" | "publication" | "offers", productId: string) => Promise<boolean>;
  centralFounder: (actor: Actor) => Promise<{ confirmed: boolean }>;
}

export interface SileoCtx {
  cfg: StoreConfig;
  db: Db;
  registry: Registry;
  sessions: SessionStore;
  accessDeps: AccessDeps;
  ledger: PaymentLedger;
  commerce: Commerce;
  admin: AdminKit;
  now: () => number;
  paymentsReady: boolean;
  startLogin: (res: ServerResponse, returnTo: string, purpose: "web" | "sileo", purposeData: string | null) => void;
  streamArtifact: (res: ServerResponse, storageKey: string, fileName: string, contentType: string) => void;
  /** The TEST provider: signs and delivers its webhook event (the only thing that changes the checkout). */
  simulateTestPayment: (chk: CheckoutSession, outcome: "pay" | "fail" | "pending" | "cancel") => Promise<void>;
  hasConnect: boolean;
}

// ---------------------------------------------------------------- small helpers

/** Sileo and Zebra treat `success: false` / `error` as failure and forget their token when `invalidate` is true. */
function fail(res: ServerResponse, status: number, error: string, opts: { invalidate?: boolean; recoveryUrl?: string } = {}) {
  json(res, status, { success: false, error, ...(opts.invalidate ? { invalidate: true } : {}), ...(opts.recoveryUrl ? { recovery_url: opts.recoveryUrl } : {}) });
}

export function priceText(unitAmount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(unitAmount / 100);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${currency}`;
  }
}

/** Keyed hash of a device identifier: comparable, but the identifier cannot be recovered from the database alone. */
function deviceHash(cfg: StoreConfig, udid: unknown): string | null {
  if (typeof udid !== "string" || udid.length < 8 || udid.length > 128) return null;
  return createHmac("sha256", cfg.secretKey).update(`hcg-store-pm-device:${udid}`).digest("hex").slice(0, 32);
}

function modelName(model: unknown): string | null {
  return typeof model === "string" && /^[A-Za-z0-9,._ -]{2,40}$/.test(model) ? model : null;
}

/** Per key, at most `perMinute` calls a minute (in memory; protects sign-in, purchases and download grants). */
function limiter(perMinute: number) {
  const w = new Map<string, { start: number; n: number }>();
  return (key: string, t: number) => {
    const x = w.get(key);
    if (!x || t - x.start >= 60_000) {
      w.set(key, { start: t, n: 1 });
      if (w.size > 10_000) for (const [k, v] of w) if (t - v.start >= 60_000) w.delete(k);
      return true;
    }
    return ++x.n <= perMinute;
  };
}
const limits = { auth: limiter(20), purchase: limiter(10), download: limiter(30), info: limiter(240) };

function clientIp(req: IncomingMessage): string {
  const h = req.headers["fly-client-ip"];
  return (Array.isArray(h) ? h[0] : h) ?? req.socket.remoteAddress ?? "unknown";
}

function clientName(req: IncomingMessage): string {
  const ua = String(req.headers["user-agent"] ?? "");
  return /zebra/i.test(ua) ? "Zebra" : /sileo/i.test(ua) ? "Sileo" : "Package manager";
}

// ---------------------------------------------------------------- credentials

type TokenRow = {
  token_hash: string; secret_hash: string; session_id_hash: string; sub: string; ref: string; device_hash: string | null; expires_at: number | null; revoked_at: number | null; last_used_at: number | null; client: string | null;
};

type Resolved = { status: "ok"; session: Session; row: TokenRow } | { status: "invalid" } | { status: "unavailable" };

async function resolveToken(ctx: SileoCtx, req: IncomingMessage, body: Record<string, unknown>): Promise<Resolved> {
  const token = body.token;
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { status: "invalid" };
  const row = ctx.db.prepare("SELECT token_hash, secret_hash, session_id_hash, sub, ref, device_hash, expires_at, revoked_at, last_used_at, client FROM repo_tokens WHERE token_hash = ?").get(sha256Hex(token)) as TokenRow | undefined;
  if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= ctx.now())) return { status: "invalid" };
  // Bound to the device it was issued to (Sileo and Zebra send the device identifier with every request).
  if (row.device_hash && deviceHash(ctx.cfg, body.udid) !== row.device_hash) return { status: "invalid" };
  const s = ctx.sessions.byHash(row.session_id_hash);
  if (!s || s.sub !== row.sub) return { status: "invalid" };
  const f = await ctx.sessions.ensureFresh(s);
  if (f.status === "ended") {
    revokeRow(ctx, row.token_hash, "hcg-session-ended");
    return { status: "invalid" };
  }
  if (f.status !== "ok") return { status: "unavailable" };
  if (!row.last_used_at || ctx.now() - row.last_used_at > 60_000) ctx.db.prepare("UPDATE repo_tokens SET last_used_at = ? WHERE token_hash = ?").run(ctx.now(), row.token_hash);
  // Sign-in runs in the system web view (a Safari user agent); the app's own requests say which app it is.
  const client = clientName(req);
  if (client !== "Package manager" && row.client !== client) ctx.db.prepare("UPDATE repo_tokens SET client = ? WHERE token_hash = ?").run(client, row.token_hash);
  return { status: "ok", session: f.session, row };
}

function revokeRow(ctx: SileoCtx, tokenHash: string, reason: string) {
  ctx.db.prepare("UPDATE repo_tokens SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL").run(ctx.now(), reason, tokenHash);
}

/**
 * Ends one package-manager credential (sign-out in Sileo, the account page, or an administrator). The Store session it
 * was bound to ends too, so the HCG Connect tokens held for it are discarded.
 */
export function revokePackageManager(ctx: Pick<SileoCtx, "db" | "sessions" | "now" | "commerce">, where: { ref: string; sub: string } | { tokenHash: string }, reason: string, actor: string): boolean {
  const row = ("ref" in where
    ? ctx.db.prepare("SELECT token_hash, session_id_hash, ref, sub FROM repo_tokens WHERE ref = ? AND sub = ? AND revoked_at IS NULL").get(where.ref, where.sub)
    : ctx.db.prepare("SELECT token_hash, session_id_hash, ref, sub FROM repo_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(where.tokenHash)) as { token_hash: string; session_id_hash: string; ref: string; sub: string } | undefined;
  if (!row) return false;
  ctx.db.prepare("UPDATE repo_tokens SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL").run(ctx.now(), reason, row.token_hash);
  // Outstanding download grants of this credential stop working at once.
  ctx.db.prepare("UPDATE repo_download_grants SET used_at = COALESCE(used_at, ?) WHERE token_hash = ?").run(ctx.now(), row.token_hash);
  ctx.sessions.end(row.session_id_hash, reason === "sign-out" ? "logout" : "revoked");
  ctx.commerce.audit(actor, "package-manager.revoked", row.ref, { reason });
  return true;
}

/** The account page's list. No token, secret or device identifier ever leaves the server. */
export function packageManagersOf(ctx: Pick<SileoCtx, "db" | "now">, sub: string) {
  const rows = ctx.db.prepare("SELECT ref, client, device_model, created_at, last_used_at, expires_at, revoked_at, revoked_reason, device_hash FROM repo_tokens WHERE sub = ? ORDER BY created_at DESC LIMIT 50").all(sub) as {
    ref: string; client: string | null; device_model: string | null; created_at: number; last_used_at: number | null; expires_at: number | null; revoked_at: number | null; revoked_reason: string | null; device_hash: string | null;
  }[];
  const t = ctx.now();
  return rows.map((r) => ({
    ref: r.ref,
    client: r.client ?? "Package manager",
    deviceModel: r.device_model,
    deviceBound: !!r.device_hash,
    connectedAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    status: r.revoked_at !== null ? "revoked" : r.expires_at !== null && r.expires_at <= t ? "expired" : "active",
    endedAt: r.revoked_at,
    endedReason: r.revoked_reason,
  }));
}

// ---------------------------------------------------------------- availability and profile

function providerInfo(ctx: SileoCtx) {
  const p = ctx.commerce.effective();
  return { name: p.name, description: p.description, icon: p.icon, authentication_banner: { message: p.bannerMessage, button: p.bannerButton } };
}

/** Internal testing: the Founder (confirmed by HCG) and people HCG lets administer HCG Store. */
async function internalTester(ctx: SileoCtx, session: Session): Promise<boolean> {
  const actor: Actor = { sub: session.sub, accessToken: session.accessToken, via: "web" };
  try {
    if ((await ctx.admin.centralFounder(actor)).confirmed) return true;
    for (const p of ["offers", "publication", "approve", "publish"] as const) if (await ctx.admin.permitted(actor, p, "hcg.store")) return true;
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- packages

type Mapped = { channel: Channel; product: NonNullable<ReturnType<typeof findProduct>>; editionId: string | null };

function mapPackage(ctx: SileoCtx, packageId: string): Mapped | null {
  const channel = ctx.commerce.channel(packageId);
  if (!channel || channel.status !== "active") return null;
  const product = findProduct(ctx.registry, channel.productId);
  if (!product) return null;
  return { channel, product, editionId: channel.editionId };
}

/**
 * Whether this access decision counts as "purchased": an HCG entitlement (licence, purchase, Founder/Owner), or a
 * release HCG Store published as free for every HCG account (an open free testing window or a free edition).
 */
function entitled(_channel: Channel, a: EditionAccess): boolean {
  return a.owned || a.state === "free";
}

/**
 * HCG Store-issued package-manager token → its live session (no device check: HCG Repo's servers present it on the
 * person's behalf through the server-to-server contract). Revoked, expired and ended credentials are invalid.
 */
export async function sessionForToken(ctx: Pick<SileoCtx, "db" | "sessions" | "now">, token: unknown): Promise<{ status: "ok"; session: Session } | { status: "invalid" } | { status: "unavailable" }> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { status: "invalid" };
  const row = ctx.db.prepare("SELECT session_id_hash, sub, expires_at, revoked_at FROM repo_tokens WHERE token_hash = ?").get(sha256Hex(token)) as
    | { session_id_hash: string; sub: string; expires_at: number | null; revoked_at: number | null }
    | undefined;
  if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= ctx.now())) return { status: "invalid" };
  const s = ctx.sessions.byHash(row.session_id_hash);
  if (!s || s.sub !== row.sub) return { status: "invalid" };
  const f = await ctx.sessions.ensureFresh(s);
  return f.status === "ok" ? { status: "ok", session: f.session } : f.status === "ended" ? { status: "invalid" } : { status: "unavailable" };
}

/**
 * The approved, deliverable .deb files of a product edition (catalogue releases and the CURRENT published HCG Store
 * release of each target), optionally only those this access may receive and those matching a Debian version
 * (`<version>` or `<version>-<revision>`) and architecture.
 */
export function eligibleFiles(ctx: Pick<SileoCtx, "registry" | "cfg">, product: Product, editionId: string | null, a: EditionAccess | null, opts: { version?: string; architecture?: string }) {
  return deliverableArtifacts(ctx.registry, product, editionId)
    .filter((f) => f.fileName.endsWith(".deb") && (a === null || mayDownload(a, f.id)))
    .map((f) => {
      const facts = debFacts(ctx, f);
      return facts ? { file: f, version: facts.version, architectures: facts.architectures, size: facts.size } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .filter((x) => (!opts.architecture || x.architectures.includes(opts.architecture)) && (!opts.version || opts.version === x.version || debianVersionMatches(opts.version, x.version)));
}

/** The single offer a package manager can show (one price): a one-time offer first. */
function packageOffer(ctx: SileoCtx, m: Mapped): Offer | undefined {
  const offers = offersFor(ctx.registry, m.product, m.editionId);
  return offers.find((o) => o.kind === "one-time") ?? offers[0];
}

function purchasesAllowed(ctx: SileoCtx): { ok: true } | { ok: false; reason: string } {
  const eff = ctx.commerce.effective();
  if (eff.paymentMode === "off") return { ok: false, reason: "Purchases from package managers are not available yet. Nothing was charged." };
  if (!ctx.paymentsReady) return { ok: false, reason: "Checkout is not available yet. Nothing was charged." };
  return { ok: true };
}

/** Facts about a deliverable .deb: its version, architectures, size and SHA-256. */
export function debFacts(ctx: Pick<SileoCtx, "registry" | "cfg">, f: ProtectedArtifact): { version: string; architectures: string[]; size: number | null } | null {
  const rel = ctx.registry.catalogue.releases.find((r) => r.id === f.releaseId);
  if (rel) {
    const cat = rel.artifacts.find((x) => x.id === f.catalogueArtifactId);
    let size: number | null = null;
    try {
      const root = resolve(ctx.cfg.artifactStorageDir);
      const file = resolve(root, f.storageKey);
      if (file.startsWith(root + sep) && existsSync(file)) size = statSync(file).size;
    } catch {
      size = null;
    }
    return { version: rel.version, architectures: cat?.architectures ?? [], size };
  }
  const pm = ctx.registry.published?.publishedMeta(f.id);
  return pm && pm.format === "deb" ? { version: pm.version, architectures: pm.architectures, size: pm.sizeBytes } : null;
}

/** Update eligibility ("same-major"): purchases record the version current when they started. */
function updateEligible(ctx: SileoCtx, m: Mapped, sub: string, version: string): boolean {
  if (m.channel.updatePolicy === "all-updates") return true;
  const offerIds = new Set(offersFor(ctx.registry, m.product, m.editionId).map((o) => o.id));
  const bought = ctx.ledger.purchasesFor(sub).filter((p) => offerIds.has(p.offer_id) && ["paid", "active", "canceled"].includes(p.status) && p.version_at_purchase);
  // An entitlement HCG granted without a Store purchase (licence, Founder/Owner) covers every version.
  if (!bought.length) return true;
  const want = majorOf(version);
  return bought.some((p) => majorOf(p.version_at_purchase!) === want);
}

// ---------------------------------------------------------------- routes

export async function sileoRoute(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const base = url.pathname.startsWith(SILEO_BASE) ? SILEO_BASE : LEGACY_SILEO_BASE;
  const p = url.pathname.slice(base.length);
  const m = req.method ?? "GET";
  const t = ctx.now();
  const eff = ctx.commerce.effective();
  let match: RegExpExecArray | null;

  // Grants already issued keep their own checks; everything else needs the provider switched on.
  if ((match = /^download\/([A-Za-z0-9_-]{30,60})$/.exec(p)) && (m === "GET" || m === "HEAD")) return serveGrant(ctx, req, res, match[1]!);
  if ((match = /^checkout\/([A-Za-z0-9_-]{30,60})$/.exec(p)) && (m === "GET" || m === "POST")) return checkoutPage(ctx, req, res, match[1]!);
  if (p.startsWith("internal-source/")) return internalSource(ctx, req, res, p.slice("internal-source/".length));

  if (eff.availability === "disabled") return fail(res, 503, "HCG Store's package-manager service is not available yet.");

  if (p === "info" && m === "GET") return json(res, 200, providerInfo(ctx), { "cache-control": "public, max-age=300" });

  if (p === "authenticate" && m === "GET") {
    if (!ctx.hasConnect) return fail(res, 503, "HCG Connect sign-in is not configured.");
    if (!limits.auth(`ip:${clientIp(req)}`, t)) return fail(res, 429, "Too many sign-in attempts. Try again in a minute.");
    const data = JSON.stringify({ d: deviceHash(ctx.cfg, url.searchParams.get("udid")), m: modelName(url.searchParams.get("model")), c: clientName(req) === "Package manager" ? null : clientName(req) });
    return ctx.startLogin(res, "/", "sileo", data);
  }

  if ((match = /^package\/([^/]{2,128})\/info$/.exec(p)) && m === "GET") {
    // Zebra asks without a body when signed out (and falls back to POST otherwise).
    if (!limits.info(`ip:${clientIp(req)}`, t)) return fail(res, 429, "Too many requests. Try again in a minute.");
    return packageInfo(ctx, res, decodeURIComponent(match[1]!), null);
  }

  if (m !== "POST") return fail(res, 405, "Method not allowed.");
  const body = await readJson<Record<string, unknown>>(req);

  if (p === "sign_out") {
    if (typeof body.token === "string" && body.token.length <= 200) revokePackageManager(ctx, { tokenHash: sha256Hex(body.token) }, "sign-out", "package-manager");
    return json(res, 200, { success: true });
  }

  if ((match = /^package\/([^/]{2,128})\/info$/.exec(p))) {
    if (!limits.info(`ip:${clientIp(req)}`, t)) return fail(res, 429, "Too many requests. Try again in a minute.");
    if (body.token === undefined || body.token === null || body.token === "none") return packageInfo(ctx, res, decodeURIComponent(match[1]!), null);
  }

  const r = await resolveToken(ctx, req, body);
  if (r.status === "unavailable") return fail(res, 503, "HCG could not be reached. Nothing has changed; try again shortly.");
  if (r.status === "invalid") return fail(res, 401, "Your HCG sign-in has ended. Sign in again.", { invalidate: true });
  const { session, row } = r;
  // Internal testing applies to every request, so moving back from public to internal stops other accounts at once.
  if (eff.availability === "internal" && !(await internalTester(ctx, session))) {
    return fail(res, 403, "HCG Store's package-manager service is in internal testing.", { invalidate: true });
  }

  if (p === "user_info") {
    const items: string[] = [];
    for (const c of ctx.commerce.channels().filter((x) => x.status === "active" && x.access !== "free")) {
      const product = findProduct(ctx.registry, c.productId);
      if (!product) continue;
      const a = await decideAccess(ctx.accessDeps, product, c.editionId, session);
      if (a.state === "unavailable") return fail(res, 503, "Your purchases could not be checked right now. Try again shortly.");
      if (entitled(c, a)) items.push(c.packageId);
    }
    return json(res, 200, { items, user: { name: session.name ?? session.email ?? "HCG account", email: session.email ?? "" } });
  }

  if (!(match = /^package\/([^/]{2,128})\/(info|purchase|authorize_download)$/.exec(p))) return fail(res, 404, "Not found.");
  const packageId = decodeURIComponent(match[1]!);
  const action = match[2]!;
  if (action === "info") return packageInfo(ctx, res, packageId, session);
  const mapped = mapPackage(ctx, packageId);
  if (!mapped) return fail(res, 404, "This package is not distributed through HCG Store.");

  if (action === "purchase") {
    if (!limits.purchase(`tok:${row.token_hash}`, t)) return json(res, 200, { status: -1, error: "Too many purchase attempts. Try again in a minute." });
    // The payment secret is held in the device's Keychain behind the passcode; a wrong one ends the credential.
    if (typeof body.payment_secret === "string" && !safeEqual(sha256Hex(body.payment_secret), row.secret_hash)) {
      revokePackageManager(ctx, { tokenHash: row.token_hash }, "payment-secret-mismatch", "package-manager");
      return fail(res, 401, "This device's HCG Store credentials are no longer valid. Sign in again.", { invalidate: true });
    }
    if (mapped.channel.access !== "paid") return json(res, 200, { status: 0 });
    const a = await decideAccess(ctx.accessDeps, mapped.product, mapped.editionId, session);
    if (a.state === "unavailable") return json(res, 200, { status: -1, error: "Your purchases could not be checked right now. Nothing was charged." });
    if (a.owned) return json(res, 200, { status: 0 });
    const allowed = purchasesAllowed(ctx);
    if (!allowed.ok) return json(res, 200, { status: -1, error: allowed.reason });
    const offer = packageOffer(ctx, mapped);
    if (!offer || !a.checkoutReady) return json(res, 200, { status: -1, error: a.checkoutUnavailableReason ?? "This package is not for sale yet. Nothing was charged." });
    const current = currentReleaseOf(ctx.registry.catalogue, mapped.product);
    const chk = ctx.ledger.createCheckout(session.sub, offer, ctx.cfg.paymentProvider, { channel: "package-manager", versionAtPurchase: current?.version ?? null });
    const link = randomToken(32);
    ctx.db.prepare("INSERT INTO pm_checkouts (checkout_id, token_hash, package_id, link_hash, link_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(chk.id, row.token_hash, packageId, sha256Hex(link), t + CHECKOUT_LINK_TTL_MS, t);
    ctx.commerce.audit(session.sub, "package-manager.checkout-started", chk.id, { packageId, offerId: offer.id, amount: offer.unitAmount, currency: offer.currency, credential: row.ref });
    return json(res, 200, { status: 1, url: `${ctx.cfg.publicOrigin}${SILEO_BASE}checkout/${link}` });
  }

  // authorize_download
  if (!limits.download(`tok:${row.token_hash}`, t)) return fail(res, 429, "Too many download requests. Try again in a minute.");
  if (mapped.channel.access === "free") return fail(res, 400, "This package is free: install it from HCG Repo directly.");
  const repo = typeof body.repo === "string" ? normalizeRepo(body.repo) : null;
  if (!repo || !eff.repositories.includes(repo) || normalizeRepo(mapped.channel.repository) !== repo) {
    return fail(res, 403, "This repository is not associated with HCG Store for this package.");
  }
  const version = typeof body.version === "string" && /^[A-Za-z0-9.+~:-]{1,64}$/.test(body.version) ? body.version : null;
  const arch = typeof body.architecture === "string" ? body.architecture : "iphoneos-arm";
  if (!version) return fail(res, 400, "The package version is missing.");
  if (!mapped.channel.architectures.includes(arch)) return fail(res, 404, `This package is not distributed for ${arch}.`);
  const a = await decideAccess(ctx.accessDeps, mapped.product, mapped.editionId, session);
  if (a.state === "unavailable") return fail(res, 503, "Your access could not be checked right now. Try again shortly.");
  if (!entitled(mapped.channel, a)) return fail(res, 403, "Your HCG account does not include this package.", { recoveryUrl: `${ctx.cfg.publicOrigin}/apps/${mapped.product.slug}${mapped.editionId ? `?edition=${encodeURIComponent(mapped.editionId)}` : ""}` });
  if (!a.downloadsAvailable) return fail(res, 403, DOWNLOADS_NOT_AVAILABLE);
  if (!updateEligible(ctx, mapped, session.sub, version)) return fail(res, 403, "Your purchase does not include this major version. Check HCG Store for an upgrade.");
  const file = eligibleFiles(ctx, mapped.product, mapped.editionId, a, { version, architecture: arch })[0]?.file;
  if (!file) return fail(res, 404, "No approved file matches this version and architecture.");
  const grant = randomToken(32);
  ctx.db
    .prepare("INSERT INTO repo_download_grants (id_hash, token_hash, sub, artifact_id, sha256, package_id, version, architecture, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sha256Hex(grant), row.token_hash, session.sub, file.id, file.sha256, packageId, version, arch, t, t + ctx.cfg.downloadUrlTtlSeconds * 1000);
  ctx.db.prepare("DELETE FROM repo_download_grants WHERE expires_at < ?").run(t - 24 * 3600_000);
  return json(res, 200, { url: `${ctx.cfg.publicOrigin}${SILEO_BASE}download/${grant}` });
}

async function packageInfo(ctx: SileoCtx, res: ServerResponse, packageId: string, session: Session | null) {
  const mapped = mapPackage(ctx, packageId);
  if (!mapped) return fail(res, 404, "This package is not distributed through HCG Store.");
  const { channel } = mapped;
  const a = await decideAccess(ctx.accessDeps, mapped.product, mapped.editionId, session);
  if (a.state === "unavailable") return fail(res, 503, "Your access could not be checked right now. Try again shortly.");
  const offer = packageOffer(ctx, mapped);
  const has = session ? entitled(channel, a) : false;
  if (channel.access !== "paid") {
    // Free with an HCG account: nothing to buy; "purchased" once signed in.
    return json(res, 200, { price: "Free", purchased: has ? 1 : 0, available: has ? (a.downloadsAvailable ? 1 : 0) : 1 });
  }
  const sellable = !!offer && a.checkoutReady && purchasesAllowed(ctx).ok;
  return json(res, 200, {
    price: has ? (a.owned ? "Purchased" : "Free") : offer ? priceText(offer.unitAmount, offer.currency) : "Not for sale",
    purchased: has ? 1 : 0,
    available: has ? (a.downloadsAvailable ? 1 : 0) : sellable ? 1 : 0,
  });
}

/**
 * The URL handed to Sileo. Single use: the first request consumes it, whatever happens next. Re-checked when used:
 * the credential, its session, the entitlement, the release and the file's SHA-256 must all still be good.
 */
async function serveGrant(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, grant: string) {
  const deny = (msg: string) => fail(res, 403, msg);
  const idHash = sha256Hex(grant);
  const g = transaction(ctx.db, () => {
    const row = ctx.db.prepare("SELECT * FROM repo_download_grants WHERE id_hash = ?").get(idHash) as
      | { token_hash: string; sub: string; artifact_id: string; sha256: string; package_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.used_at !== null || row.expires_at <= ctx.now()) return { row, ok: false };
    if (req.method !== "HEAD") ctx.db.prepare("UPDATE repo_download_grants SET used_at = ? WHERE id_hash = ?").run(ctx.now(), idHash);
    return { row, ok: true };
  });
  if (!g.row) return deny("This download link is not valid.");
  if (!g.ok) return deny(g.row.used_at !== null ? "This download link has already been used. Start the download again in your package manager." : "This download link has expired. Start the download again in your package manager.");
  const row = g.row;
  const tok = ctx.db.prepare("SELECT session_id_hash, sub, revoked_at, expires_at FROM repo_tokens WHERE token_hash = ?").get(row.token_hash) as { session_id_hash: string; sub: string; revoked_at: number | null; expires_at: number | null } | undefined;
  if (!tok || tok.revoked_at !== null || tok.sub !== row.sub || (tok.expires_at !== null && tok.expires_at <= ctx.now())) return deny("Your HCG sign-in for this device has ended.");
  const s = ctx.sessions.byHash(tok.session_id_hash);
  if (!s || s.sub !== row.sub) return deny("Your HCG sign-in for this device has ended.");
  const fresh = await ctx.sessions.ensureFresh(s);
  if (fresh.status !== "ok") return fail(res, fresh.status === "ended" ? 403 : 503, fresh.status === "ended" ? "Your HCG sign-in for this device has ended." : "HCG could not be reached. Try again shortly.");
  const file = findArtifact(ctx.registry, row.artifact_id);
  const mapped = mapPackage(ctx, row.package_id);
  if (!file || !mapped || file.productId !== mapped.product.id || file.sha256 !== row.sha256) return deny("This file is no longer available.");
  const a = await decideAccess(ctx.accessDeps, mapped.product, file.editionId, fresh.session);
  if (!entitled(mapped.channel, a) || !mayDownload(a, file.id)) return deny("Your HCG account does not include this package.");
  if (req.method === "HEAD") return send(res, 200, "", { "content-type": "application/vnd.debian.binary-package" });
  return ctx.streamArtifact(res, file.storageKey, file.fileName, "application/vnd.debian.binary-package");
}

// ---------------------------------------------------------------- package-manager checkout page

const PAGE_CSS = `body{font:16px/1.5 system-ui,sans-serif;background:#05070c;color:#e6ebf2;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;padding:2rem;margin:1rem;border:1px solid #2a3442;border-radius:16px;background:#0b1018}.banner{background:#5a3b00;color:#ffd58a;padding:.5rem .75rem;border-radius:8px;font-weight:600}button,.button{display:inline-block;font:inherit;margin:.25rem .5rem .25rem 0;padding:.6rem 1rem;border-radius:10px;border:1px solid #3b4757;background:#141b26;color:#e6ebf2;cursor:pointer;text-decoration:none}button[value=pay],.button.primary{background:#0e3b42;border-color:#2fd3e6}.muted{color:#9aa7b8;font-size:.9rem}img{width:56px;height:56px;border-radius:14px;vertical-align:middle;margin-right:.75rem}`;

function page(ctx: SileoCtx, res: ServerResponse, status: number, title: string, bodyHtml: string) {
  const icon = ctx.commerce.effective().icon;
  html(
    res,
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · HCG Store</title><style>${PAGE_CSS}</style></head><body><main><p><img src="${escapeHtml(icon)}" alt="">${escapeHtml(ctx.commerce.effective().name)}</p>${bodyHtml}</main></body></html>`,
    { "content-security-policy": `default-src 'none'; img-src ${new URL(icon).origin}; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, "referrer-policy": "same-origin" },
  );
}

const RETURN = `<p><a class="button primary" href="sileo://payment_completed">Return to your package manager</a></p>`;

async function checkoutPage(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, link: string) {
  const row = ctx.db.prepare("SELECT checkout_id, package_id, link_expires_at FROM pm_checkouts WHERE link_hash = ?").get(sha256Hex(link)) as { checkout_id: string; package_id: string; link_expires_at: number } | undefined;
  const chk = row ? ctx.ledger.checkout(row.checkout_id) : null;
  if (!row || !chk) return page(ctx, res, 404, "Checkout", `<h1>Checkout not found</h1><p>Start the purchase again in your package manager. Nothing was charged.</p>${RETURN}`);
  const offer = ctx.registry.offers.find((o) => o.id === chk.offerId);
  const price = `${priceText(chk.amount, chk.currency)}${offer?.kind === "subscription" ? ` per ${escapeHtml(offer.interval ?? "")}` : ""}`;
  const statusPage = (c: CheckoutSession) => {
    const msg = {
      completed: "<h1>Purchase confirmed</h1><p>The payment provider confirmed the payment. Your HCG account now includes this package. Go back to your package manager and install it.</p>",
      pending: "<h1>Payment pending</h1><p>The payment provider has not confirmed the payment yet. Your HCG account will include the package as soon as it does.</p>",
      failed: "<h1>Payment failed</h1><p>The payment provider reported that the payment failed. Nothing was charged and nothing was added to your account.</p>",
      canceled: "<h1>Purchase cancelled</h1><p>Nothing was charged and nothing was added to your account.</p>",
      open: "<h1>Payment not completed</h1><p>Nothing was charged.</p>",
    }[c.status];
    return page(ctx, res, 200, "Checkout", `${msg}${RETURN}<p class="muted">Purchases made in Sileo or Zebra appear in your HCG Store account history.</p>`);
  };
  if (chk.status !== "open") return statusPage(chk);
  if (row.link_expires_at <= ctx.now()) return page(ctx, res, 410, "Checkout", `<h1>This checkout has expired</h1><p>Start the purchase again in your package manager. Nothing was charged.</p>${RETURN}`);
  if (ctx.cfg.paymentProvider !== "test" || ctx.commerce.effective().paymentMode !== "test") {
    return page(ctx, res, 503, "Checkout", `<h1>Checkout is not available</h1><p>Payments are not switched on. Nothing was charged.</p>${RETURN}`);
  }
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin !== ctx.cfg.publicOrigin) return page(ctx, res, 403, "Checkout", `<h1>Request refused</h1><p>This form must be sent from HCG Store's own page. Nothing was charged.</p>`);
    const body = await readJson<{ outcome?: string }>(req);
    const outcome = body.outcome;
    if (outcome !== "pay" && outcome !== "fail" && outcome !== "cancel") return page(ctx, res, 400, "Checkout", "<h1>Unknown choice</h1>");
    // The TEST provider's signed webhook is the only thing that changes the checkout; this page only reports it.
    await ctx.simulateTestPayment(chk, outcome);
    ctx.db.prepare("UPDATE pm_checkouts SET completed_page_at = ? WHERE checkout_id = ?").run(ctx.now(), chk.id);
    return statusPage(ctx.ledger.checkout(chk.id)!);
  }
  return page(
    ctx,
    res,
    200,
    "TEST checkout",
    `<p class="banner">TEST MODE — no real payment is taken and no card details are requested.</p>
<h1>${escapeHtml(offer?.title ?? row.package_id)}</h1><p>Price: <strong>${price}</strong></p>
<p class="muted">Package ${escapeHtml(row.package_id)}. Access is granted only when the payment provider's signed event confirms the payment.</p>
<form method="post"><button name="outcome" value="pay">Simulate successful payment</button><button name="outcome" value="fail">Simulate failed payment</button><button name="outcome" value="cancel">Cancel</button></form>`,
  );
}

// ---------------------------------------------------------------- sign-in completion

export async function completePackageManagerLogin(ctx: SileoCtx, res: ServerResponse, session: Session, data: string | null) {
  let meta: { d?: string | null; m?: string | null; c?: string } = {};
  try {
    meta = data ? (JSON.parse(data) as typeof meta) : {};
  } catch {
    meta = {};
  }
  const eff = ctx.commerce.effective();
  const refuse = (msg: string) => {
    ctx.sessions.end(session.idHash, "refused");
    return page(ctx, res, 403, "Sign-in", `<h1>Sign-in not completed</h1><p>${escapeHtml(msg)}</p><p class="muted">Nothing was changed.</p>`);
  };
  if (eff.availability === "disabled") return refuse("HCG Store's package-manager service is not available yet.");
  if (eff.availability === "internal" && !(await internalTester(ctx, session))) {
    return refuse("HCG Store's package-manager sign-in is in internal testing. It opens to every HCG account when HCG Store launches it.");
  }
  const token = randomToken(32);
  const secret = randomToken(24);
  const ref = `pms_${randomToken(12)}`;
  const t = ctx.now();
  ctx.db
    .prepare("INSERT INTO repo_tokens (token_hash, secret_hash, session_id_hash, sub, created_at, ref, device_hash, device_model, client, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sha256Hex(token), sha256Hex(secret), session.idHash, session.sub, t, ref, meta.d ?? null, meta.m ?? null, meta.c ?? "Package manager", t + ctx.cfg.sessionAbsoluteSeconds * 1000);
  ctx.commerce.audit(session.sub, "package-manager.connected", ref, { client: meta.c ?? "Package manager", deviceModel: meta.m ?? null, deviceBound: !!meta.d, availability: eff.availability });
  // The protocol returns the credentials on the callback URL (Sileo and Zebra read them from it). They are HCG
  // Store's own, revocable, and never an HCG Connect token. No browser cookie is set for this sign-in.
  redirect(res, `sileo://authentication_success?token=${encodeURIComponent(token)}&payment_secret=${encodeURIComponent(secret)}`);
}

// ---------------------------------------------------------------- internal test source

/**
 * A minimal flat APT source for INTERNAL testing only (availability "internal"): add
 * `<store>/api/sileo/v1/internal-source/` in Sileo to test sign-in, purchase and download before HCG Repo advertises
 * the provider. It lists the active paid and sign-in packages with the facts of their approved files (version,
 * architecture, size, SHA-256), tagged commercial, with a Filename that is never served. Metadata only: no file bytes,
 * no account data. It does not exist when the provider is disabled or public.
 */
function internalSource(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, file: string) {
  const eff = ctx.commerce.effective();
  if (eff.availability !== "internal" || (req.method !== "GET" && req.method !== "HEAD")) return fail(res, 404, "Not found.");
  const textHeaders = { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" };
  if (file === "payment_endpoint") return send(res, 200, `${ctx.cfg.publicOrigin}${SILEO_BASE}\n`, textHeaders);
  const packages = internalPackages(ctx);
  if (file === "Packages") return send(res, 200, packages, textHeaders);
  if (file === "Release") {
    const size = Buffer.byteLength(packages);
    const release = [
      "Origin: HCG Store (internal testing)",
      "Label: HCG Store internal testing",
      "Suite: stable",
      "Version: 1.0",
      "Codename: hcg-store-internal",
      `Architectures: ${[...new Set(ctx.commerce.channels().flatMap((c) => c.architectures))].sort().join(" ") || "iphoneos-arm64"}`,
      "Components: main",
      "Description: INTERNAL TESTING ONLY. HCG Store's package-manager payment provider, before HCG Repo advertises it.",
      "SHA256:",
      ` ${sha256Hex(packages)} ${size} Packages`,
      "",
    ].join("\n");
    return send(res, 200, release, textHeaders);
  }
  return fail(res, 404, "Not found.");
}

function internalPackages(ctx: SileoCtx): string {
  const out: string[] = [];
  for (const c of ctx.commerce.channels().filter((x) => x.status === "active" && x.access !== "free")) {
    const product = findProduct(ctx.registry, c.productId);
    if (!product) continue;
    const edition = c.editionId ? product.editions.find((e) => e.id === c.editionId) : null;
    for (const f of deliverableArtifacts(ctx.registry, product, c.editionId).filter((x) => x.fileName.endsWith(".deb"))) {
      const facts = debFacts(ctx, f);
      if (!facts || facts.size === null) continue;
      for (const arch of facts.architectures.filter((a) => c.architectures.includes(a))) {
        out.push(
          [
            `Package: ${c.packageId}`,
            `Version: ${facts.version}`,
            `Architecture: ${arch}`,
            `Name: ${product.name}${edition ? ` ${edition.name}` : ""}`.replace(/\s+/g, " "),
            `Description: ${(product.summary ?? product.name).replace(/\s+/g, " ").slice(0, 200)}`,
            "Section: Tweaks",
            "Maintainer: Hakmi Capital Group",
            "Author: Hakmi Capital Group",
            "Tag: cydia::commercial",
            `Filename: protected/${f.fileName}`,
            `Size: ${facts.size}`,
            `SHA256: ${f.sha256}`,
            ...(c.minIos ? [`Depends: firmware (>= ${c.minIos})`] : []),
            "",
          ].join("\n"),
        );
      }
    }
  }
  return out.join("\n");
}

/** Every Sileo-compatible response body for one package, as an anonymous visitor sees it (Studio preview). */
export async function previewResponses(ctx: SileoCtx, packageId: string | null) {
  const capture = async (fn: (res: ServerResponse) => unknown) => {
    let status = 0;
    let body = "";
    const fake = {
      headersSent: false,
      writeHead(s: number) { status = s; return fake; },
      end(b?: string | Buffer) { body = b ? String(b) : ""; },
      setHeader() {},
    } as unknown as ServerResponse;
    await fn(fake);
    return { status, body: body ? (JSON.parse(body) as unknown) : null };
  };
  const info = { status: 200, body: providerInfo(ctx) };
  const pkg = packageId ? await capture((res) => packageInfo(ctx, res, packageId, null)) : null;
  return {
    endpoint: `${ctx.cfg.publicOrigin}${SILEO_BASE}`,
    info,
    packageInfo: pkg,
    authenticationCallback: "sileo://authentication_success?token=<HCG Store package-manager token>&payment_secret=<payment secret>",
    paymentCallback: "sileo://payment_completed",
  };
}
