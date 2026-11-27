/**
 * Public release resolution (versioned): which approved release of a product is current, and how each of its files
 * can be obtained through HCG Store. For product websites (for example HCG Trading) that link visitors to a download.
 *
 *   GET /api/public/v1/release-resolution/:product[?platform=macos&arch=arm64]
 *
 * What it exposes: catalogue product metadata that is already public on the product page, and the current release
 * a person approved and published (the approver's explicit "current" choice, or the catalogue's currentReleaseId):
 * version, channel, notes, known limitations, and per file its name, platform, architectures, size, SHA-256, minimum
 * OS and signing status as reported. What it never exposes: file locations or download URLs, drafts, unpublished or
 * withdrawn releases, account or audit data. Every option links to the product page, where downloads require an HCG
 * account and the Store's own access checks (ownership or an open free testing window); this interface grants nothing.
 */
import type { StoreConfig } from "./config";
import { currentReleaseOf, type Registry } from "./registry";
import { PLATFORM_IDS } from "../../src/domain/taxonomy";

export const RELEASE_RESOLUTION_FORMAT = "hcg.store.release-resolution/1";

export interface LivePublished {
  currentPublishedFor(productId: string): {
    releaseId: string; editionId: string | null; version: string; build: string; channel: string; distribution: string; publishedAt: number;
    releaseNotes: string[]; knownLimitations: string[];
    files: { id: string; fileName: string; platform: string; format: string; kind: string | null; architectures: string[]; minimumOs: string | null; sizeBytes: number; sha256: string; signing: string }[];
  }[];
  freeWindowFor(productId: string, editionId: string | null): { endsAt: number; releaseId: string | null } | null;
}

type Access =
  | { kind: "free-testing"; requiresHcgAccount: true; freeUntil: string }
  | { kind: "free-with-account"; requiresHcgAccount: true }
  | { kind: "free-public"; requiresHcgAccount: false }
  | { kind: "licence-required"; requiresHcgAccount: true }
  | { kind: "not-available-yet"; requiresHcgAccount: true };

export class ResolutionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function resolveRelease(
  deps: { cfg: Pick<StoreConfig, "publicOrigin" | "freeDownloads" | "protectedDownloads"> & Partial<Pick<StoreConfig, "anonymousFreeProducts">>; registry: Registry; live: LivePublished | null; now: number },
  idOrSlug: string,
  filter: { platform?: string | null; arch?: string | null },
) {
  const { cfg, registry, live } = deps;
  const product = registry.catalogue.products.find((p) => p.id === idOrSlug || p.slug === idOrSlug);
  if (!product || product.visibility === "draft") throw new ResolutionError(404, "not_found", "Unknown product.");
  if (filter.platform && !(PLATFORM_IDS as readonly string[]).includes(filter.platform)) throw new ResolutionError(400, "bad_platform", `platform must be one of ${PLATFORM_IDS.join(", ")}.`);
  if (filter.arch && !/^[A-Za-z0-9_.-]{1,40}$/.test(filter.arch)) throw new ResolutionError(400, "bad_arch", "arch is an architecture name such as arm64 or x64.");

  const productUrl = `${cfg.publicOrigin}/apps/${product.slug}`;
  const editionName = (id: string | null) => product.editions.find((e) => e.id === id)?.name ?? null;
  const accessFor = (editionId: string | null, distribution: string, releaseId: string, livePublished: boolean): Access => {
    const w = live?.freeWindowFor(product.id, editionId);
    const pricing0 = product.editions.find((e) => e.id === editionId)?.pricingModel ?? null;
    // Free without an account: a published free release of a product approved for it (permanently free or in a window).
    if (livePublished && distribution === "free" && cfg.freeDownloads && (cfg.anonymousFreeProducts ?? []).includes(product.id)
        && (pricing0 === "free" || (w && (w.releaseId === null || w.releaseId === releaseId)))) return { kind: "free-public", requiresHcgAccount: false };
    // Free testing only for a published release the open window covers (the named one, or any when it names none).
    if (w && livePublished && (w.releaseId === null || w.releaseId === releaseId) && distribution === "free" && cfg.freeDownloads) return { kind: "free-testing", requiresHcgAccount: true, freeUntil: new Date(w.endsAt).toISOString() };
    const pricing = product.editions.find((e) => e.id === editionId)?.pricingModel ?? null;
    if (distribution === "free" && pricing === "free" && cfg.freeDownloads) return { kind: "free-with-account", requiresHcgAccount: true };
    if (distribution !== "free" && cfg.protectedDownloads) return { kind: "licence-required", requiresHcgAccount: true };
    return { kind: "not-available-yet", requiresHcgAccount: true };
  };
  const matches = (f: { platform: string; architectures: string[] }) =>
    (!filter.platform || f.platform === filter.platform) && (!filter.arch || f.architectures.length === 0 || f.architectures.includes(filter.arch));

  // Live: what a person approved as current and published in HCG Store. Otherwise the catalogue's current release.
  const livePublished = live?.currentPublishedFor(product.id) ?? [];
  type Rel = { id: string; version: string; build: string | null; channel: string; releaseDate: string | null; releaseNotes: string[]; knownLimitations: string[]; source: "hcg-store-publication" | "catalogue" };
  const releases: { release: Rel; editionId: string | null; distribution: string; files: { fileName: string; platform: string; format: string; kind: string | null; architectures: string[]; minimumOs: string | null; sizeBytes: number | null; sha256: string | null; signing: string }[] }[] = [];
  if (livePublished.length) {
    for (const r of livePublished) {
      releases.push({
        release: { id: r.releaseId, version: r.version, build: r.build, channel: r.channel, releaseDate: new Date(r.publishedAt).toISOString().slice(0, 10), releaseNotes: r.releaseNotes, knownLimitations: r.knownLimitations, source: "hcg-store-publication" },
        editionId: r.editionId, distribution: r.distribution, files: r.files,
      });
    }
  } else {
    const cur = currentReleaseOf(registry.catalogue, product);
    if (cur) {
      const editions = [...new Set(cur.artifacts.map((a) => a.editionId ?? null))];
      for (const editionId of editions) {
        releases.push({
          release: { id: cur.id, version: cur.version, build: cur.build ?? null, channel: cur.channel, releaseDate: cur.releaseDate ?? null, releaseNotes: cur.releaseNotes, knownLimitations: cur.knownLimitations ?? [], source: "catalogue" },
          editionId,
          distribution: product.editions.find((e) => e.id === editionId)?.pricingModel === "free" ? "free" : "paid",
          files: cur.artifacts.filter((a) => (a.editionId ?? null) === editionId).map((a) => ({
            fileName: a.fileName, platform: a.platform, format: a.format, kind: null, architectures: a.architectures, minimumOs: a.minimumOs ?? null,
            sizeBytes: a.sizeBytes ?? null, sha256: a.sha256 ?? null, signing: a.signing.status,
          })),
        });
      }
    }
  }

  const options = releases.flatMap((r) =>
    r.files.filter(matches).map((f) => ({
      releaseId: r.release.id,
      editionId: r.editionId,
      editionName: editionName(r.editionId),
      platform: f.platform,
      architectures: f.architectures,
      format: f.format,
      kind: f.kind,
      fileName: f.fileName,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      minimumOs: f.minimumOs,
      signing: f.signing,
      access: accessFor(r.editionId, r.distribution, r.release.id, r.release.source === "hcg-store-publication"),
      // Where a visitor gets it: the product page (sign-in, access checks and delivery happen there).
      getUrl: `${productUrl}${r.editionId ? `?edition=${encodeURIComponent(r.editionId)}` : ""}`,
    })),
  );
  const byRelease = new Map(releases.map((r) => [r.release.id, r.release]));
  return {
    format: RELEASE_RESOLUTION_FORMAT,
    generatedAt: new Date(deps.now).toISOString(),
    product: {
      id: product.id,
      slug: product.slug,
      name: product.name,
      summary: product.summary,
      developmentStatus: product.developmentStatus,
      productUrl,
      platforms: product.platforms.map((p) => ({ platform: p.platform, support: p.support })),
    },
    releases: [...byRelease.values()],
    options,
    filter: { platform: filter.platform ?? null, arch: filter.arch ?? null },
    note: (cfg.anonymousFreeProducts ?? []).includes(product.id) && cfg.freeDownloads
      ? "Downloads happen on the product page. Free public files of this product need no HCG account; every other file needs an HCG account and HCG Store's access checks. This response grants nothing and contains no download URLs."
      : "Downloads happen on the product page with an HCG account and HCG Store's access checks. This response grants nothing and contains no download URLs.",
  };
}
