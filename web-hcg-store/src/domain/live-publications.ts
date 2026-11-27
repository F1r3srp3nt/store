import type { Catalogue } from "./catalogue";
import { ReleaseSchema, type PlatformEntry, type Release } from "./schema";
import { PLATFORM_IDS } from "./taxonomy";

/**
 * HCG Store's live publications (`GET /api/public/v1/published`): the releases each product has CURRENTLY published
 * through HCG Store (Control Center, HCG Executable Maker, HCG Store Manager). Metadata only.
 */
export interface LivePublication {
  releaseId: string;
  editionId: string | null;
  version: string;
  build: string;
  channel: string;
  distribution: string;
  publishedAt: number;
  releaseNotes: string[];
  knownLimitations: string[];
  files: { id: string; fileName: string; platform: string; format: string; architectures: string[]; minimumOs: string | null; sizeBytes: number; sha256: string; signing: string }[];
}
export interface LivePublications {
  format: "hcg.store.published/1";
  products: Record<string, LivePublication[]>;
}

const SIGNING = new Set(["unsigned", "signed", "notarized", "not-stated"]);

/** A signed or notarized status needs evidence in the catalogue schema: HCG Store's own published record is it. */
function signingOf(status: string): { status: "unsigned" | "signed" | "notarized" | "not-stated"; evidence: string | null } {
  const s = (SIGNING.has(status) ? status : "not-stated") as "unsigned" | "signed" | "notarized" | "not-stated";
  return { status: s, evidence: s === "signed" || s === "notarized" ? "Recorded by HCG Store for this published release (signing verified at import)." : null };
}

function asRelease(productId: string, p: LivePublication): Release | null {
  const parsed = ReleaseSchema.safeParse({
    id: p.releaseId,
    productId,
    version: p.version,
    build: p.build || null,
    channel: p.channel,
    status: "approved",
    releaseDate: new Date(p.publishedAt).toISOString().slice(0, 10),
    releaseNotes: p.releaseNotes,
    knownLimitations: p.knownLimitations,
    artifacts: p.files.map((f) => ({
      id: f.id, platform: f.platform, architectures: f.architectures, fileName: f.fileName, format: f.format, sizeBytes: f.sizeBytes,
      sha256: f.sha256, minimumOs: f.minimumOs, signing: signingOf(f.signing), editionId: p.editionId,
    })),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Brings the catalogue up to date with HCG Store's live publications, so every page (product page, cards, spotlight,
 * New releases, platform and search listings) follows a publication without a catalogue edit:
 * - a published release not yet in the catalogue is added (as published, with its real files);
 * - a product without an explicit current release gets the Store's current one, but ONLY when the Store has exactly
 *   one current release for it. With several (e.g. one per platform), nothing is inferred: the catalogue still needs
 *   an explicit choice, and each release keeps its own platform availability.
 * - every platform with a live published file is shown as available (confirmed, with the published architectures and
 *   minimum OS), so platform listings, cards and search follow a new platform's publication. A platform the catalogue
 *   already confirms keeps its curated entry.
 * An explicit catalogue `currentReleaseId` is never overridden. Drafts and withdrawn releases never appear here.
 */
export function applyLivePublications(c: Catalogue, live: LivePublications | null): Catalogue {
  if (!live || live.format !== "hcg.store.published/1" || !live.products) return c;
  const releases = [...c.releases];
  const known = new Set(releases.map((r) => r.id));
  const products = c.products.map((product) => {
    const pubs = live.products[product.id];
    if (!Array.isArray(pubs) || !pubs.length || product.visibility === "draft") return product;
    for (const p of pubs) {
      if (known.has(p.releaseId)) continue;
      const r = asRelease(product.id, p);
      if (r) {
        releases.push(r);
        known.add(r.id);
      }
    }
    const withPlatforms = { ...product, platforms: livePlatforms(product.platforms, pubs) };
    if (product.currentReleaseId || pubs.length !== 1 || !known.has(pubs[0]!.releaseId)) return withPlatforms;
    return { ...withPlatforms, currentReleaseId: pubs[0]!.releaseId };
  });
  return { ...c, products, releases };
}

const PLATFORM_SET = new Set<string>(PLATFORM_IDS);

/** Platforms with live published files become confirmed; the catalogue's confirmed entries are kept as written. */
function livePlatforms(entries: PlatformEntry[], pubs: LivePublication[]): PlatformEntry[] {
  const out = [...entries];
  const byPlatform = new Map<string, { archs: Set<string>; minimumOs: string | null; pub: LivePublication }>();
  for (const p of pubs) {
    for (const f of p.files ?? []) {
      if (!PLATFORM_SET.has(f.platform)) continue;
      const cur = byPlatform.get(f.platform) ?? { archs: new Set<string>(), minimumOs: f.minimumOs ?? null, pub: p };
      for (const a of f.architectures ?? []) cur.archs.add(a);
      byPlatform.set(f.platform, cur);
    }
  }
  for (const [platform, live] of byPlatform) {
    const i = out.findIndex((e) => e.platform === platform);
    if (i >= 0 && out[i]!.support === "confirmed") continue;
    const archs = [...live.archs];
    const entry: PlatformEntry = {
      platform: platform as PlatformEntry["platform"],
      support: "confirmed",
      architectures: archs,
      minimumOs: live.minimumOs,
      note: `${live.pub.channel === "beta" ? "Public Beta" : "Version"} ${live.pub.version}${archs.length ? ` for ${archs.join(", ")}` : ""}, published in HCG Store.`,
    };
    if (i >= 0) out[i] = entry;
    else out.push(entry);
  }
  return out;
}
