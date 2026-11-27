/**
 * Sileo payment-provider API for HCG Repo packages, served by HCG Store so that package delivery
 * enforces exactly the same ownership rules as the Store website.
 *
 * Protocol (as implemented by Sileo's client, Sileo/Backend/Payment Manager/*.swift):
 * - The repository advertises this endpoint in `<repo>/payment_endpoint` (HTTPS only).
 * - Sign-in opens `authenticate` in the system web-authentication sheet; on success the Store
 *   redirects to `sileo://authentication_success?token=…&payment_secret=…`.
 * - Later requests are JSON POSTs carrying `token` (and, for purchases, `payment_secret`) in the
 *   BODY. Nothing is ever put in the APT source URL.
 * - `package/<id>/authorize_download` returns a short-lived HTTPS URL; Sileo downloads it.
 *
 * The token given to Sileo is a Store-issued, revocable HCG Repo token, never an HCG Connect token.
 * It is bound to a Store session, so HCG session expiry, Store sign-out and sign-out from Sileo all
 * end it, and every authorised download re-checks the session and the entitlement.
 *
 * Purchases (Sileo and Zebra, both verified from their sources): `package/<id>/purchase` answers status 1 with an
 * HTTPS URL that the client opens in a web-authentication session with callback scheme `sileo`. That URL is a signed,
 * 30-minute purchase context bound to the account that asked (`checkout/<ctx>`): the person signs in to the Store if
 * needed, buys through the normal Store checkout, and `checkout/<ctx>/return` redirects to `sileo://payment_completed`
 * once the Store sees the purchase (the provider's verified event grants it; the return URL grants nothing).
 * Restoring purchases is `user_info` (items the account owns or may use free right now).
 *
 * Package managers send `udid`, `model` and `device`: they are ignored and never stored.
 *
 * Status: implemented and tested against simulated clients only. Not advertised by HCG Repo until launch is
 * approved (see docs/HCG-REPO.md and docs/REPO-ENTITLEMENTS.md).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { decideAccess, deliverableArtifacts, DOWNLOADS_NOT_AVAILABLE, mayDownload, type AccessDeps } from "./access";
import type { StoreConfig } from "./config";
import { randomToken, sha256Hex, signPayload, verifyPayload } from "./crypto";
import type { Db } from "./db";
import type { EntitlementAuthority } from "./entitlements";
import type { HcgConnectClient } from "./hcg-connect";
import { errorJson, escapeHtml, html, json, readJson, redirect } from "./http";
import { findArtifact, findByPackageId, type Registry } from "./registry";
import type { Product } from "../../src/domain/schema";
import type { Session, SessionStore } from "./sessions";

export interface SileoCtx {
  cfg: StoreConfig;
  db: Db;
  registry: Registry;
  sessions: SessionStore;
  connect: HcgConnectClient | null;
  authority: EntitlementAuthority;
  accessDeps: AccessDeps;
  now: () => number;
  startLogin: (res: ServerResponse, returnTo: string, purpose: "web" | "sileo", purposeData: string | null) => void;
  streamArtifact: (res: ServerResponse, storageKey: string, fileName: string, contentType: string) => void;
  freshSession: (req: IncomingMessage) => Promise<{ session: Session | null; unavailable: boolean }>;
}

/**
 * The files of a product edition this access may receive, for a Debian version and architecture: approved catalogue
 * files and the CURRENT published HCG Store release of each target (superseded, disabled, revoked and withdrawn
 * releases are never eligible). `version` matches the release version or `<version>-<revision>`.
 */
export function eligibleFiles(ctx: Pick<SileoCtx, "registry">, product: Product, editionId: string | null, a: Awaited<ReturnType<typeof decideAccess>> | null, opts: { version?: string; architecture?: string }) {
  // a = null: what is approved and current for anyone entitled (HCG Repo's package listing), no per-person check.
  return deliverableArtifacts(ctx.registry, product, editionId).filter((f) => a === null || mayDownload(a, f.id)).map((f) => {
    const rel = ctx.registry.catalogue.releases.find((r) => r.id === f.releaseId);
    const cat = rel?.artifacts.find((x) => x.id === f.catalogueArtifactId);
    const meta = rel ? { version: rel.version, architectures: cat?.architectures ?? [] } : ctx.registry.published?.publishedMeta(f.id);
    return meta ? { file: f, version: meta.version, architectures: meta.architectures } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x && x.file.fileName.endsWith(".deb")).filter((x) =>
    (!opts.architecture || x.architectures.includes(opts.architecture)) &&
    (!opts.version || opts.version === x.version || opts.version.startsWith(`${x.version}-`)));
}

/** A signed purchase context: one package, one HCG account, 30 minutes. */
type PurchaseCtx = { p: string; s: string; exp: number };
const PURCHASE_TTL_MS = 30 * 60 * 1000;

/** Sileo treats `success: false` / `error` as failure and clears its token when `invalidate` is true. */
function fail(res: ServerResponse, status: number, error: string, invalidate = false) {
  json(res, status, { success: false, error, ...(invalidate ? { invalidate: true } : {}) });
}

type TokenRow = { session_id_hash: string; sub: string; secret_hash: string; revoked_at: number | null };

export async function sessionForToken(ctx: Pick<SileoCtx, "db" | "sessions">, token: unknown): Promise<{ status: "ok"; session: Session } | { status: "invalid" } | { status: "unavailable" }> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { status: "invalid" };
  const row = ctx.db.prepare(`SELECT session_id_hash, sub, secret_hash, revoked_at FROM repo_tokens WHERE token_hash = ?`).get(sha256Hex(token)) as
    | TokenRow
    | undefined;
  if (!row || row.revoked_at !== null) return { status: "invalid" };
  const s = ctx.sessions.byHash(row.session_id_hash);
  if (!s || s.sub !== row.sub) return { status: "invalid" };
  const f = await ctx.sessions.ensureFresh(s);
  if (f.status === "ok") return { status: "ok", session: f.session };
  if (f.status === "ended") return { status: "invalid" };
  return { status: "unavailable" };
}

function priceText(unitAmount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(unitAmount / 100);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${currency}`;
  }
}

async function route(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, url: URL) {
  const base = "/repo-api/v1/sileo/";
  const p = url.pathname.slice(base.length);
  const m = req.method ?? "GET";
  let match: RegExpExecArray | null;

  if (p === "info" && m === "GET") {
    return json(res, 200, {
      name: "HCG Store",
      description: "Access to HCG Repo packages with your HCG account.",
      icon: `${ctx.cfg.publicOrigin}/brand/icon-512.png`,
      authentication_banner: { message: "Sign in with your HCG account to check access to HCG packages.", button: "Sign in" },
    });
  }
  if (p === "authenticate" && m === "GET") {
    if (!ctx.connect) return fail(res, 503, "HCG Connect sign-in is not configured.");
    return ctx.startLogin(res, "/", "sileo", null);
  }
  // Zebra asks for package info with GET while signed out (to let the provider cache it): price and availability only.
  if ((match = /^package\/([a-z0-9][a-z0-9.+-]{1,127})\/info$/.exec(p)) && m === "GET") {
    const mapped = findByPackageId(ctx.registry, match[1]!);
    if (!mapped) return fail(res, 404, "This package is not sold through HCG Store.");
    const a = await decideAccess(ctx.accessDeps, mapped.product, mapped.edition.id, null);
    const offer = a.offers[0];
    return json(res, 200, { price: offer ? priceText(offer.unitAmount, offer.currency) : mapped.edition.pricingModel === "free" ? "Free" : "Not for sale", purchased: 0, available: a.checkoutReady ? 1 : 0 });
  }
  // Purchase from a package manager (opened in its web-authentication session; see the header).
  if ((match = /^checkout\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/return)?$/.exec(p)) && m === "GET") return purchaseFlow(ctx, req, res, match[1]!, !!match[2]);
  if (m !== "POST") return fail(res, 405, "Method not allowed.");

  const body = await readJson<Record<string, unknown>>(req);
  if (p === "sign_out") {
    if (typeof body.token === "string") {
      ctx.db.prepare(`UPDATE repo_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(ctx.now(), sha256Hex(body.token));
    }
    return json(res, 200, { success: true });
  }

  const t = await sessionForToken(ctx, body.token);
  if (t.status === "unavailable") return fail(res, 503, "HCG could not be reached. Nothing has changed; try again shortly.");
  if (t.status === "invalid") return fail(res, 401, "Your HCG sign-in has ended. Sign in again.", true);
  const session = t.session;

  if (p === "user_info") {
    const items: string[] = [];
    for (const product of ctx.registry.catalogue.products) {
      for (const edition of product.editions) {
        const pkg = edition.identifiers.find((i) => i.kind === "debian-package")?.value;
        if (!pkg) continue;
        const a = await decideAccess(ctx.accessDeps, product, edition.id, session);
        if (a.owned || a.state === "free") items.push(pkg);
      }
    }
    return json(res, 200, { items, user: { name: session.name ?? session.email ?? "HCG account", email: session.email ?? "" } });
  }

  if ((match = /^package\/([a-z0-9][a-z0-9.+-]{1,127})\/(info|purchase|authorize_download)$/.exec(p))) {
    const mapped = findByPackageId(ctx.registry, match[1]!);
    if (!mapped) return fail(res, 404, "This package is not sold through HCG Store.");
    const { product, edition } = mapped;
    const a = await decideAccess(ctx.accessDeps, product, edition.id, session);
    if (a.state === "unavailable") return fail(res, 503, "Your access could not be checked right now. Try again shortly.");
    const action = match[2]!;

    if (action === "info") {
      const offer = a.offers[0];
      return json(res, 200, {
        price: a.owned ? "Owned" : a.state === "free" ? "Free" : offer ? priceText(offer.unitAmount, offer.currency) : "Not for sale",
        purchased: a.owned || a.state === "free" ? 1 : 0,
        available: a.downloadsAvailable || (!a.owned && a.checkoutReady) ? 1 : 0,
      });
    }
    if (action === "purchase") {
      // A purchase request never grants access. Checkout happens on the Store; access appears only
      // after the payment provider's verified event.
      if (a.owned || a.state === "free") return json(res, 200, { status: 0 });
      if (!a.checkoutReady) return json(res, 200, { status: -1, error: a.checkoutUnavailableReason ?? "Not for sale." });
      // Status 1: the client opens this URL (HTTPS, this Store) in its web-authentication session and waits for
      // sileo://payment_completed. The context binds the package and this account; it grants nothing by itself.
      const pctx = signPayload(ctx.cfg.secretKey, "repo-purchase", { p: match[1]!, s: session.sub, exp: ctx.now() + PURCHASE_TTL_MS } satisfies PurchaseCtx);
      return json(res, 200, { status: 1, url: `${ctx.cfg.publicOrigin}/repo-api/v1/sileo/checkout/${pctx}` });
    }
    // authorize_download
    if (!a.owned && a.state !== "free") return fail(res, 403, "Your HCG account does not include this package.");
    if (!a.downloadsAvailable) return fail(res, 403, DOWNLOADS_NOT_AVAILABLE);
    const version = typeof body.version === "string" ? body.version : "";
    const arch = typeof body.architecture === "string" ? body.architecture : "iphoneos-arm";
    const file = eligibleFiles(ctx, product, edition.id, a, { version, architecture: arch })[0]?.file;
    if (!file) return fail(res, 404, "No approved file matches this version and layout.");
    const exp = ctx.now() + ctx.cfg.downloadUrlTtlSeconds * 1000;
    const signed = signPayload(ctx.cfg.secretKey, "repo-file", { a: file.id, s: session.sub, h: session.idHash, exp });
    return json(res, 200, { url: `${ctx.cfg.publicOrigin}/repo-api/v1/files/${signed}` });
  }
  return fail(res, 404, "Not found.");
}

/**
 * `checkout/<ctx>`: inside the package manager's web-authentication session. Sign in (the same HCG account that asked
 * in the app), then the Store's own product page and checkout. `checkout/<ctx>/return`: back to the app with
 * sileo://payment_completed once the purchase shows in HCG (after the provider's verified event), never before.
 */
async function purchaseFlow(ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, token: string, isReturn: boolean) {
  const c = verifyPayload<PurchaseCtx>(ctx.cfg.secretKey, "repo-purchase", token);
  if (!c || c.exp < ctx.now()) return page(res, 410, "This purchase link has expired", "Start the purchase again from the package manager.");
  const mapped = findByPackageId(ctx.registry, c.p);
  if (!mapped) return page(res, 404, "Unknown package", "This package is not sold through HCG Store.");
  const fresh = await ctx.freshSession(req);
  if (fresh.unavailable) return page(res, 503, "HCG could not be reached", "Nothing was charged. Try again shortly.");
  if (!fresh.session) return ctx.startLogin(res, `/repo-api/v1/sileo/checkout/${token}${isReturn ? "/return" : ""}`, "web", null);
  if (fresh.session.sub !== c.s) {
    return page(res, 403, "Different HCG account", "This purchase was started in the package manager with another HCG account. Sign out of HCG Store in this window and sign in with the account the package manager uses.");
  }
  const { product, edition } = mapped;
  const a = await decideAccess(ctx.accessDeps, product, edition.id, fresh.session);
  if (a.state === "unavailable") return page(res, 503, "Access could not be checked", "Nothing was charged. Try again shortly.");
  if (a.owned || a.state === "free") return redirect(res, "sileo://payment_completed");
  if (isReturn) {
    return page(res, 200, "Payment not completed yet", "HCG Store has not received a completed payment for this package. If you paid, it can take a moment: reload this page. Your package manager is updated when it is complete.", `/repo-api/v1/sileo/checkout/${token}/return`);
  }
  if (!a.checkoutReady) return page(res, 403, "Not for sale", a.checkoutUnavailableReason ?? "This package is not for sale yet.");
  return redirect(res, `/apps/${product.slug}?edition=${encodeURIComponent(edition.id)}&buy=1&pm=${encodeURIComponent(token)}`);
}

function page(res: ServerResponse, status: number, title: string, text: string, reload?: string) {
  html(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · HCG Store</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#05070c;color:#e6ebf2;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:32rem;padding:2rem}a{color:#45e1f5}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${reload ? `<p><a href="${escapeHtml(reload)}">Check again</a></p>` : ""}</main></body></html>`);
}

/**
 * Short-lived file URL handed to Sileo. Expires after HCG_STORE_DOWNLOAD_URL_TTL_SECONDS (120 s by
 * default) and is re-checked when used: the session must still be active and the entitlement must
 * still be granted, so revocation applies even inside the expiry window.
 */
async function serveFile(ctx: SileoCtx, res: ServerResponse, token: string) {
  const payload = verifyPayload<{ a: string; s: string; h: string; exp: number }>(ctx.cfg.secretKey, "repo-file", token);
  if (!payload || payload.exp < ctx.now()) return errorJson(res, 403, "link_expired", "This download link has expired.");
  const s = ctx.sessions.byHash(payload.h);
  if (!s || s.sub !== payload.s) return errorJson(res, 403, "link_expired", "This download link is no longer valid.");
  const file = findArtifact(ctx.registry, payload.a);
  const product = file ? ctx.registry.catalogue.products.find((p) => p.id === file.productId) : undefined;
  if (!file || !product || (!ctx.cfg.protectedDownloads && !ctx.cfg.freeDownloads)) return errorJson(res, 403, "not_available", DOWNLOADS_NOT_AVAILABLE);
  const a = await decideAccess(ctx.accessDeps, product, file.editionId, s);
  if (!mayDownload(a, file.id)) {
    return errorJson(res, 403, "not_entitled", "Your HCG account does not include this package.");
  }
  return ctx.streamArtifact(res, file.storageKey, file.fileName, "application/vnd.debian.binary-package");
}

function completeLogin(ctx: SileoCtx, res: ServerResponse, session: Session) {
  const token = randomToken(32);
  const secret = randomToken(24);
  ctx.db
    .prepare(`INSERT INTO repo_tokens (token_hash, secret_hash, session_id_hash, sub, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256Hex(token), sha256Hex(secret), session.idHash, session.sub, ctx.now());
  // Sileo's protocol returns the credentials on its callback URL. They are Store-issued and
  // revocable, and are never an HCG Connect token. The browser session cookie is not set.
  redirect(res, `sileo://authentication_success?token=${encodeURIComponent(token)}&payment_secret=${encodeURIComponent(secret)}`);
}

export const handleSileo = {
  route: async (ctx: SileoCtx, req: IncomingMessage, res: ServerResponse, url: URL) => route(ctx, req, res, url),
  completeLogin: (ctx: SileoCtx, res: ServerResponse, session: Session, _data: string | null) => completeLogin(ctx, res, session),
  serveFile,
};
