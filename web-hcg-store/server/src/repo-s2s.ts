/**
 * HCG Repo ⇄ HCG Store server-to-server contract, version 1 (`hcg.store.repo-entitlements/1`). Full contract:
 * docs/REPO-ENTITLEMENTS.md.
 *
 *   GET  /api/s2s/v1/repo/packages                    every package HCG Store sells or gives through HCG Repo: mapping,
 *                                                     pricing model, free testing, and the CURRENT eligible versions
 *                                                     (version, architectures, size, SHA-256). Never a file URL.
 *   POST /api/s2s/v1/repo/entitlements/verify         may the person behind a package-manager token receive this package
 *                                                     (and version, architecture)? Decided now, with HCG's central check.
 *
 * Authentication: HMAC-SHA256 over `METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA-256(BODY)` with the key HCG
 * Store shares with HCG Repo's servers (X-HCG-Key-Id, X-HCG-Timestamp in seconds, X-HCG-Nonce 16-64 URL-safe
 * characters, X-HCG-Signature base64url). ±300 s; each nonce is accepted once. Off unless HCG_STORE_REPO_S2S_KEY_ID and HCG_STORE_REPO_S2S_SECRET are set.
 *
 * Authority stays where it is: HCG decides entitlements (licences, subscriptions, refunds and revocations are HCG's
 * records, checked live with the person's own HCG session), HCG Store decides releases and free testing, and HCG
 * Repo asks. HCG Repo never names a person: it presents the Store-issued package-manager token the person's Sileo or
 * Zebra holds, so it cannot ask about anyone who has not signed in through it. Delivery stays with HCG Store
 * (`authorize_download`, short-lived signed URL, re-checked at use); this API never returns a file or a file URL.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { decideAccess, type AccessDeps } from "./access";
import type { StoreConfig } from "./config";
import type { Db } from "./db";
import type { EntitlementAuthority } from "./entitlements";
import { errorJson, json, readBody } from "./http";
import type { Commerce } from "./commerce";
import { findProduct, type Registry } from "./registry";
import type { SessionStore } from "./sessions";
import { eligibleFiles, sessionForToken, SILEO_BASE } from "./sileo";

export const REPO_ENTITLEMENTS_FORMAT = "hcg.store.repo-entitlements/1";

export interface RepoS2sDeps {
  cfg: StoreConfig;
  db: Db;
  registry: Registry;
  sessions: SessionStore;
  accessDeps: AccessDeps;
  authority: EntitlementAuthority;
  commerce: Commerce;
  now: () => number;
}

const WINDOW_S = 300;

export function signRepoRequest(secret: Buffer, method: string, pathAndQuery: string, timestamp: number, nonce: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${digest}`).digest("base64url");
}

export function createRepoS2s(deps: RepoS2sDeps) {
  const { cfg, registry, now } = deps;
  const seen = new Map<string, number>();

  function authenticate(req: IncomingMessage, url: URL, body: string): string | null {
    const k = cfg.repoS2s!;
    const keyId = String(req.headers["x-hcg-key-id"] ?? "");
    const ts = Number(req.headers["x-hcg-timestamp"] ?? "");
    const nonce = String(req.headers["x-hcg-nonce"] ?? "");
    const sig = String(req.headers["x-hcg-signature"] ?? "");
    if (keyId !== k.keyId) return "unknown_key";
    if (!Number.isInteger(ts) || Math.abs(now() / 1000 - ts) > WINDOW_S) return "stale_or_missing_timestamp";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return "missing_nonce";
    const want = signRepoRequest(k.secret, req.method ?? "GET", url.pathname + url.search, ts, nonce, body);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return "bad_signature";
    const t = now();
    for (const [n, at] of seen) if (t - at > 2 * WINDOW_S * 1000) seen.delete(n);
    if (seen.has(nonce)) return "replayed";
    seen.set(nonce, t);
    return null;
  }

  /**
   * Every package HCG Store distributes through HCG Repo: the repository-package channels that are active or suspended
   * (Payment Provider Studio), each mapped to its catalogue product and edition. Drafts are not shared.
   */
  function packages() {
    const out = [];
    for (const c of deps.commerce.channels().filter((x) => x.status !== "draft")) {
      const product = findProduct(registry, c.productId);
      const edition = product?.editions.find((e) => e.id === c.editionId);
      if (product && edition) out.push({ product, edition, packageId: c.packageId, channel: c });
    }
    return out;
  }

  async function packageView(p: ReturnType<typeof packages>[number]) {
    // What anyone entitled could receive now (approved and current files; no per-person check here).
    const window = registry.published?.freeWindowFor?.(p.product.id, p.edition.id) ?? null;
    const files = eligibleFiles({ registry, cfg }, p.product, p.edition.id, null, {});
    return {
      packageId: p.packageId,
      productId: p.product.id,
      slug: p.product.slug,
      editionId: p.edition.id,
      editionName: p.edition.name,
      centralProductId: p.product.registry.centralId,
      centralEditionKey: p.edition.centralEditionKey ?? null,
      repoKeys: p.product.hcgRepo.map((l) => l.key),
      pricingModel: p.edition.pricingModel ?? null,
      // How HCG Repo indexes it: free packages may be public; everything else is `cydia::commercial` and delivered by
      // HCG Store only (never a public GitHub asset or a static file).
      access: p.channel.access,
      status: p.channel.status,
      repository: p.channel.repository,
      architectures: p.channel.architectures,
      minIos: p.channel.minIos,
      maxIos: p.channel.maxIos,
      updatePolicy: p.channel.updatePolicy,
      delivery: p.channel.access === "free" ? "public" : p.channel.access === "account" ? "free-with-account" : "commercial",
      freeTesting: window ? { endsAt: new Date(window.endsAt).toISOString(), releaseId: window.releaseId } : null,
      storeUrl: `${cfg.publicOrigin}/apps/${p.product.slug}?edition=${encodeURIComponent(p.edition.id)}`,
      // Advertise it in HCG Repo's payment_endpoint only once the provider is public.
      paymentEndpoint: `${cfg.publicOrigin}${SILEO_BASE}`,
      providerAvailability: deps.commerce.effective().availability,
      currentVersions: files.map((f) => ({ version: f.version, architectures: f.architectures, fileName: f.file.fileName, sha256: f.file.sha256, releaseId: f.file.releaseId })),
      downloadsEnabled: cfg.protectedDownloads || cfg.freeDownloads,
    };
  }

  const VerifyInput = z.strictObject({
    repoToken: z.string().min(20).max(200),
    packageId: z.string().regex(/^[a-z0-9][a-z0-9.+-]{1,127}$/),
    version: z.string().trim().max(100).optional(),
    architecture: z.string().trim().regex(/^[a-z0-9-]{2,40}$/).optional(),
    purpose: z.enum(["download", "listing"]).default("download"),
  });

  async function verify(input: z.infer<typeof VerifyInput>) {
    const base = { format: REPO_ENTITLEMENTS_FORMAT, checkedAt: new Date(now()).toISOString(), packageId: input.packageId };
    const mapped = packages().find((x) => x.packageId === input.packageId && x.channel.status === "active");
    if (!mapped) return { status: 404, body: { ...base, decision: "deny", reason: "unknown_package", cacheSeconds: 0 } };
    const t = await sessionForToken(deps, input.repoToken);
    if (t.status === "unavailable") return { status: 503, body: { ...base, decision: "unknown", reason: "hcg_unavailable", cacheSeconds: 0 } };
    if (t.status === "invalid") return { status: 200, body: { ...base, decision: "deny", reason: "token_invalid", cacheSeconds: 0 } };
    const { product, edition } = mapped;
    const a = await decideAccess(deps.accessDeps, product, edition.id, t.session);
    if (a.state === "unavailable") return { status: 503, body: { ...base, decision: "unknown", reason: "hcg_unavailable", cacheSeconds: 0 } };
    // Basis: HCG's entitlement (licence, subscription or owner policy) or a free release / open free testing window.
    let basis: "entitlement" | "free" | "free-testing" | null = null;
    let validUntil: number | null = null;
    if (a.owned) {
      basis = "entitlement";
      const c = product.registry.centralId
        ? await deps.authority.check({ sub: t.session.sub, accessToken: t.session.accessToken }, { centralProductId: product.registry.centralId, editionId: edition.id, centralEditionKey: edition.centralEditionKey ?? null })
        : null;
      validUntil = c?.status === "granted" ? c.expiresAt : null;
    } else if (a.state === "free") {
      basis = a.freeTesting ? "free-testing" : "free";
      validUntil = a.freeTesting?.endsAt ?? null;
    }
    const entitled = basis !== null;
    const all = entitled ? eligibleFiles({ registry, cfg }, product, edition.id, a, {}) : [];
    const matching = entitled ? eligibleFiles({ registry, cfg }, product, edition.id, a, { version: input.version, architecture: input.architecture }) : [];
    const reason = !entitled ? "not_entitled"
      : !a.downloadsAvailable ? "downloads_not_available"
      : all.length === 0 ? "no_eligible_release"
      : !matching.length && input.architecture && !all.some((f) => f.architectures.includes(input.architecture!)) ? "architecture_not_available"
      : !matching.length ? "version_not_eligible"
      : "entitled";
    const allow = reason === "entitled";
    const cacheSeconds = allow ? Math.max(0, Math.min(60, validUntil ? Math.floor((validUntil - now()) / 1000) : 60)) : 0;
    return {
      status: 200,
      body: {
        ...base,
        decision: allow ? "allow" : "deny",
        reason,
        entitled,
        basis,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
        product: { id: product.id, editionId: edition.id, centralProductId: product.registry.centralId },
        requested: { version: input.version ?? null, architecture: input.architecture ?? null, purpose: input.purpose },
        eligibleVersions: all.map((f) => ({ version: f.version, architectures: f.architectures, sha256: f.file.sha256, releaseId: f.file.releaseId })),
        delivery: allow ? { via: "hcg-store", endpoint: `${cfg.publicOrigin}${SILEO_BASE}package/${encodeURIComponent(input.packageId)}/authorize_download` } : null,
        cacheSeconds,
      },
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/s2s/v1/repo/")) return false;
    if (!cfg.repoS2s) { errorJson(res, 404, "repo_s2s_disabled", "The HCG Repo server-to-server API is not enabled on this Store."); return true; }
    const raw = req.method === "POST" ? await readBody(req, 16 * 1024) : "";
    const refused = authenticate(req, url, raw);
    if (refused) { errorJson(res, 401, "unauthenticated", `HCG Repo request refused (${refused}).`); return true; }
    if (url.pathname === "/api/s2s/v1/repo/packages" && req.method === "GET") {
      const list = [];
      for (const p of packages()) list.push(await packageView(p));
      json(res, 200, { format: REPO_ENTITLEMENTS_FORMAT, generatedAt: new Date(now()).toISOString(), payments: cfg.paymentProvider === "none" ? "disabled" : cfg.paymentProvider, packages: list });
      return true;
    }
    if (url.pathname === "/api/s2s/v1/repo/entitlements/verify" && req.method === "POST") {
      let body: unknown;
      try { body = JSON.parse(raw || "{}"); } catch { errorJson(res, 400, "bad_json", "Malformed JSON."); return true; }
      const parsed = VerifyInput.safeParse(body);
      if (!parsed.success) { errorJson(res, 400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")); return true; }
      const out = await verify(parsed.data);
      json(res, out.status, out.body);
      return true;
    }
    errorJson(res, 404, "not_found", "Not found.");
    return true;
  }

  return { route };
}
