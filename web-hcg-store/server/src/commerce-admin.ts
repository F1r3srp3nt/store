/**
 * Commerce administration API (Payment Provider Studio, repository-package distribution channel, developers) and the
 * authenticated HCG Repo package contract.
 *
 *   GET  /api/v1/commerce/overview                 profile (stored and in force), gates, channels, developers, agreements
 *   PUT  /api/v1/commerce/provider                 { revision, profile }                      (change)
 *   GET  /api/v1/commerce/provider/health          live self-check of the provider
 *   GET  /api/v1/commerce/provider/preview?package exact Sileo-compatible response bodies
 *   PUT  /api/v1/commerce/channels/:packageId      channel record                             (change)
 *   PUT  /api/v1/commerce/developers/:id           developer record                           (change)
 *   PUT  /api/v1/commerce/ownership/:productId     { developerId | null }                     (change)
 *   POST /api/v1/commerce/agreements               new commission agreement                   (change)
 *   POST /api/v1/commerce/agreements/:id/end       end an agreement                           (change)
 *   GET  /api/v1/commerce/sales?from=&to=          sales report from purchase records
 *   GET  /api/v1/commerce/audit                    commerce audit trail
 *   GET  /api/v1/repo/packages                     HCG Repo: what HCG Store distributes, per package and version
 *   POST /api/v1/repo/packages/verify              HCG Repo: does this exact .deb belong to an approved release?
 *
 * Who: reading needs one of HCG Store's staff permissions (HCG decides) or the Founder policy confirmed by HCG.
 * Changes need the Pricing and Offers permission (HCG_STORE_OFFERS_CENTRAL_ID) or the confirmed Founder policy. Browser
 * changes carry the session's CSRF token. Nothing here can grant an entitlement, change a price or record a payment.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deliverableArtifacts } from "./access";
import { ChannelInput, type Commerce } from "./commerce";
import { HttpError, json, readJson } from "./http";
import type { Actor } from "./publishing";
import { debianVersionMatches } from "./publishing";
import { findProduct, offersFor } from "./registry";
import { debFacts, previewResponses, SILEO_BASE, type SileoCtx } from "./sileo";

export interface CommerceAdminKit {
  actorOf: (req: IncomingMessage) => Promise<Actor>;
  assertCsrf: (req: IncomingMessage, actor: Actor) => void;
  permitted: (actor: Actor, permission: "publish" | "approve" | "publication" | "offers", productId: string) => Promise<boolean>;
  centralFounder: (actor: Actor) => Promise<{ confirmed: boolean }>;
}

export interface CommerceAdminCtx {
  commerce: Commerce;
  sileo: SileoCtx;
  kit: CommerceAdminKit;
}

async function rights(kit: CommerceAdminKit, actor: Actor) {
  const offers = await kit.permitted(actor, "offers", "hcg.store");
  const founder = (await kit.centralFounder(actor)).confirmed;
  const staff = offers || founder || (await kit.permitted(actor, "publication", "hcg.store")) || (await kit.permitted(actor, "approve", "hcg.store")) || (await kit.permitted(actor, "publish", "hcg.store"));
  return { read: staff, manage: offers || founder, offersPermission: offers, founder };
}

/** Facts about every channel, used by the Studio, the health inspector and HCG Repo. */
function channelReport(ctx: CommerceAdminCtx) {
  const { commerce, sileo } = ctx;
  return commerce.channels().map((c) => {
    const product = findProduct(sileo.registry, c.productId);
    const offers = product ? offersFor(sileo.registry, product, c.editionId) : [];
    const files = product
      ? deliverableArtifacts(sileo.registry, product, c.editionId).filter((f) => f.fileName.endsWith(".deb")).map((f) => {
        const facts = debFacts(sileo, f);
        return { artifactId: f.id, releaseId: f.releaseId, fileName: f.fileName, sha256: f.sha256, version: facts?.version ?? null, architectures: facts?.architectures ?? [], sizeBytes: facts?.size ?? null };
      })
      : [];
    const warnings: string[] = [];
    if (!product) warnings.push("The catalogue product no longer exists.");
    if (c.status === "active" && c.access === "paid" && !offers.length) warnings.push("No offer is approved for sale: package managers show \"Not for sale\".");
    if (c.status === "active" && c.access !== "free" && !files.length) warnings.push("No approved .deb is deliverable for this package yet (release approval, publication or the downloads switch).");
    for (const f of files) {
      const missing = f.architectures.filter((a) => !c.architectures.includes(a));
      if (missing.length) warnings.push(`${f.fileName} is built for ${missing.join(", ")}, which this channel does not distribute.`);
    }
    return { ...c, productName: product?.name ?? null, offers: offers.map((o) => ({ id: o.id, title: o.title, unitAmount: o.unitAmount, currency: o.currency, kind: o.kind, testOnly: o.testOnly })), files, warnings };
  });
}

function health(ctx: CommerceAdminCtx) {
  const { commerce, sileo } = ctx;
  const eff = commerce.effective();
  const checks: { id: string; ok: boolean; label: string; detail: string }[] = [];
  const add = (id: string, ok: boolean, label: string, detail: string) => checks.push({ id, ok, label, detail });
  const info = { name: eff.name, description: eff.description, icon: eff.icon, authentication_banner: { message: eff.bannerMessage, button: eff.bannerButton } };
  add("info-contract", typeof info.name === "string" && typeof info.description === "string" && !!info.authentication_banner.message && !!info.authentication_banner.button, "Provider info matches the Sileo contract", "name, description, icon and authentication_banner { message, button } are present.");
  add("https", sileo.cfg.publicOrigin.startsWith("https://"), "Provider served over https", sileo.cfg.publicOrigin.startsWith("https://") ? `${sileo.cfg.publicOrigin}${SILEO_BASE}` : "Sileo and Zebra refuse providers that are not https (test servers excepted).");
  add("icon", eff.icon.startsWith("https://") || sileo.cfg.mode === "test", "Icon is a public https URL", eff.icon);
  add("hcg-connect", sileo.hasConnect, "HCG Connect sign-in configured", sileo.hasConnect ? "Sign-in uses HCG Store's PKCE flow." : "Sign-in is not configured on this server.");
  add("availability", eff.availability !== "disabled", "Provider available", `In force: ${eff.availability}.${eff.notes.length ? " " + eff.notes.join(" ") : ""}`);
  add("repositories", eff.repositories.length > 0, "Repositories associated", eff.repositories.join(", ") || "None: no download can be authorised.");
  add("payments", eff.paymentMode !== "off" && sileo.paymentsReady, "Purchases possible", eff.paymentMode === "off" ? "Payments are off for package managers." : sileo.paymentsReady ? "TEST payments (no money moves)." : "Checkout is not ready on this server.");
  add("downloads", sileo.cfg.protectedDownloads, "Protected downloads switched on", sileo.cfg.protectedDownloads ? "Entitled downloads are served through single-use grants." : "HCG_STORE_PROTECTED_DOWNLOADS is not enabled (launch decision).");
  const channels = channelReport(ctx);
  const active = channels.filter((c) => c.status === "active");
  add("channels", active.length > 0, "Active repository packages", active.length ? active.map((c) => c.packageId).join(", ") : "No package is distributed through HCG Store yet.");
  for (const c of channels.filter((x) => x.warnings.length)) add(`channel:${c.packageId}`, false, `Package ${c.packageId}`, c.warnings.join(" "));
  return { checkedAt: sileo.now(), endpoint: `${sileo.cfg.publicOrigin}${SILEO_BASE}`, profile: eff, checks, ok: checks.every((c) => c.ok) };
}

export async function commerceAdminRoute(ctx: CommerceAdminCtx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const m = req.method ?? "GET";
  if (!p.startsWith("/api/v1/commerce/") && !p.startsWith("/api/v1/repo/packages")) return false;
  try {
    const { kit, commerce, sileo } = ctx;
    const actor = await kit.actorOf(req);
    if (actor.via === "web" && m !== "GET") kit.assertCsrf(req, actor);
    const r = await rights(kit, actor);
    if (!r.read) throw new HttpError(403, "not_staff", "HCG has not granted your account access to HCG Store administration.");
    const change = () => {
      if (!r.manage) throw new HttpError(403, "not_commerce_manager", "Changing commerce settings needs HCG Store's Pricing and Offers permission or HCG's Founder policy.");
    };
    let match: RegExpExecArray | null;

    if (p === "/api/v1/commerce/overview" && m === "GET") {
      return done(res, {
        rights: r,
        // Browser changes send it back in X-HCG-CSRF (bound to this Store session).
        ...(actor.via === "web" ? { csrfToken: actor.csrf } : {}),
        profile: commerce.profile(),
        effective: commerce.effective(),
        gates: {
          publicApproved: sileo.cfg.sileo.publicApproved,
          paymentProvider: sileo.cfg.paymentProvider,
          livePayments: false,
          protectedDownloads: sileo.cfg.protectedDownloads,
          endpoint: `${sileo.cfg.publicOrigin}${SILEO_BASE}`,
          internalSource: `${sileo.cfg.publicOrigin}${SILEO_BASE}internal-source/`,
        },
        channels: channelReport(ctx),
        products: sileo.registry.catalogue.products.filter((x) => x.editions.some((e) => e.identifiers.some((i) => i.kind === "debian-package"))).map((x) => ({
          id: x.id, name: x.name, editions: x.editions.map((e) => ({ id: e.id, name: e.name, pricingModel: e.pricingModel, packages: e.identifiers.filter((i) => i.kind === "debian-package").map((i) => i.value) })),
        })),
        developers: commerce.developers(),
        ownership: commerce.ownership(),
        agreements: commerce.agreements(),
      });
    }
    if (p === "/api/v1/commerce/provider" && m === "PUT") {
      change();
      const body = z.strictObject({ revision: z.number().int().min(0), profile: z.unknown() }).parse(await readJson(req));
      return done(res, { profile: commerce.updateProfile(actor.sub, body.profile, body.revision), effective: commerce.effective() });
    }
    if (p === "/api/v1/commerce/provider/health" && m === "GET") return done(res, health(ctx));
    if (p === "/api/v1/commerce/provider/preview" && m === "GET") return done(res, await previewResponses(sileo, url.searchParams.get("package")));
    if ((match = /^\/api\/v1\/commerce\/channels\/([a-z0-9][a-z0-9.+-]{1,127})$/.exec(p)) && m === "PUT") {
      change();
      return done(res, { channel: commerce.upsertChannel(actor.sub, match[1]!, ChannelInput.parse(await readJson(req))) });
    }
    if ((match = /^\/api\/v1\/commerce\/developers\/([a-z0-9-]{2,60})$/.exec(p)) && m === "PUT") {
      change();
      return done(res, { developer: commerce.upsertDeveloper(actor.sub, match[1]!, await readJson(req)) });
    }
    if ((match = /^\/api\/v1\/commerce\/ownership\/([a-z0-9-]{2,80})$/.exec(p)) && m === "PUT") {
      change();
      const body = z.strictObject({ developerId: z.string().nullable() }).parse(await readJson(req));
      return done(res, { ownership: commerce.setOwnership(actor.sub, match[1]!, body.developerId) });
    }
    if (p === "/api/v1/commerce/agreements" && m === "POST") {
      change();
      return done(res, { agreement: commerce.addAgreement(actor.sub, await readJson(req)) }, 201);
    }
    if ((match = /^\/api\/v1\/commerce\/agreements\/(agr_[A-Za-z0-9_-]+)\/end$/.exec(p)) && m === "POST") {
      change();
      return done(res, { agreement: commerce.endAgreement(actor.sub, match[1]!, sileo.now()) });
    }
    if (p === "/api/v1/commerce/sales" && m === "GET") {
      const to = Number(url.searchParams.get("to") ?? sileo.now() + 1) || sileo.now() + 1;
      const from = Number(url.searchParams.get("from") ?? to - 90 * 86400_000) || 0;
      return done(res, commerce.salesReport(from, to));
    }
    if (p === "/api/v1/commerce/audit" && m === "GET") return done(res, { entries: commerce.auditLog() });

    // ---------------------------------------------------------------- HCG Repo package contract
    if (p === "/api/v1/repo/packages" && m === "GET") {
      return done(res, {
        api_version: "v1",
        payment_endpoint: commerce.effective().availability === "public" ? `${sileo.cfg.publicOrigin}${SILEO_BASE}` : null,
        provider_availability: commerce.effective().availability,
        packages: channelReport(ctx).map((c) => ({
          package: c.packageId, product_id: c.productId, edition_id: c.editionId, status: c.status, access: c.access, repository: c.repository,
          architectures: c.architectures, min_ios: c.minIos, max_ios: c.maxIos, update_policy: c.updatePolicy,
          // Commercial packages are indexed with Tag: cydia::commercial and a Filename that is never served.
          commercial: c.access !== "free",
          versions: c.files.map((f) => ({ version: f.version, architectures: f.architectures, sha256: f.sha256, size: f.sizeBytes, release_id: f.releaseId, artifact_id: f.artifactId })),
        })),
      });
    }
    if (p === "/api/v1/repo/packages/verify" && m === "POST") {
      const b = z.strictObject({ package: z.string(), version: z.string(), architecture: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), repository: z.string().optional() }).parse(await readJson(req));
      const c = channelReport(ctx).find((x) => x.packageId === b.package);
      const problems: string[] = [];
      if (!c) problems.push("HCG Store does not distribute this package. A commercial listing without a Store channel would be orphaned.");
      else {
        if (c.status !== "active") problems.push(`The package's distribution is ${c.status}.`);
        if (!c.architectures.includes(b.architecture)) problems.push(`HCG Store does not distribute ${b.package} for ${b.architecture}.`);
        if (b.repository && c.repository !== b.repository.replace(/\/*$/, "/")) problems.push("The package is associated with another repository.");
        const f = c.files.find((x) => x.sha256 === b.sha256);
        if (!f) problems.push("This file is not an approved, published file of the package (SHA-256 mismatch).");
        else {
          if (!f.architectures.includes(b.architecture)) problems.push("The approved file is for another architecture.");
          if (f.version && !(b.version === f.version || debianVersionMatches(b.version, f.version))) problems.push(`The approved file is version ${f.version}, not ${b.version}.`);
        }
      }
      return done(res, { ok: problems.length === 0, problems, ...(c && !problems.length ? { product_id: c.productId, edition_id: c.editionId, release_id: c.files.find((x) => x.sha256 === b.sha256)!.releaseId, access: c.access } : {}) });
    }
    throw new HttpError(404, "not_found", "Not found.");
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, "invalid_request", e.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
    throw e;
  }
}

function done(res: ServerResponse, body: unknown, status = 200): true {
  json(res, status, body);
  return true;
}
