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
 * Status: implemented and tested against a simulated client only. Not advertised by HCG Repo until
 * protected package-index entries exist and launch is approved (see docs/HCG-REPO.md).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { decideAccess, deliverableArtifacts, DOWNLOADS_NOT_AVAILABLE, mayDownload, type AccessDeps } from "./access";
import type { StoreConfig } from "./config";
import { randomToken, sha256Hex, signPayload, verifyPayload } from "./crypto";
import type { Db } from "./db";
import type { EntitlementAuthority } from "./entitlements";
import type { HcgConnectClient } from "./hcg-connect";
import { errorJson, json, readJson, redirect } from "./http";
import { findArtifact, findByPackageId, type Registry } from "./registry";
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
}

/** Sileo treats `success: false` / `error` as failure and clears its token when `invalidate` is true. */
function fail(res: ServerResponse, status: number, error: string, invalidate = false) {
  json(res, status, { success: false, error, ...(invalidate ? { invalidate: true } : {}) });
}

type TokenRow = { session_id_hash: string; sub: string; secret_hash: string; revoked_at: number | null };

async function sessionForToken(ctx: SileoCtx, token: unknown): Promise<{ status: "ok"; session: Session } | { status: "invalid" } | { status: "unavailable" }> {
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
      return json(res, 200, { status: 1, url: `${ctx.cfg.publicOrigin}/apps/${product.slug}?edition=${encodeURIComponent(edition.id)}&buy=1` });
    }
    // authorize_download
    if (!a.owned && a.state !== "free") return fail(res, 403, "Your HCG account does not include this package.");
    if (!ctx.cfg.protectedDownloads || !a.downloadsAvailable) return fail(res, 403, DOWNLOADS_NOT_AVAILABLE);
    const version = typeof body.version === "string" ? body.version : "";
    const arch = typeof body.architecture === "string" ? body.architecture : "iphoneos-arm";
    const files = deliverableArtifacts(ctx.registry, product, edition.id).filter((f) => mayDownload(a, f.id)).filter((f) => {
      const rel = ctx.registry.catalogue.releases.find((r) => r.id === f.releaseId);
      const cat = rel?.artifacts.find((x) => x.id === f.catalogueArtifactId);
      const meta = rel ? { version: rel.version, architectures: cat?.architectures ?? [] } : ctx.registry.published?.publishedMeta(f.id);
      return !!meta && meta.architectures.includes(arch) && (!version || version === meta.version || version.startsWith(`${meta.version}-`));
    });
    const file = files[0];
    if (!file) return fail(res, 404, "No approved file matches this version and layout.");
    const exp = ctx.now() + ctx.cfg.downloadUrlTtlSeconds * 1000;
    const signed = signPayload(ctx.cfg.secretKey, "repo-file", { a: file.id, s: session.sub, h: session.idHash, exp });
    return json(res, 200, { url: `${ctx.cfg.publicOrigin}/repo-api/v1/files/${signed}` });
  }
  return fail(res, 404, "Not found.");
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
  if (!file || !product || !ctx.cfg.protectedDownloads) return errorJson(res, 403, "not_available", DOWNLOADS_NOT_AVAILABLE);
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
