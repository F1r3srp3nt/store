import type { Catalogue } from "./catalogue";
import { ReleaseSchema, type Release } from "./schema";

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
      sha256: f.sha256, minimumOs: f.minimumOs, signing: { status: SIGNING.has(f.signing) ? f.signing : "not-stated", evidence: null }, editionId: p.editionId,
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
    if (product.currentReleaseId || pubs.length !== 1 || !known.has(pubs[0]!.releaseId)) return product;
    return { ...product, currentReleaseId: pubs[0]!.releaseId };
  });
  return { ...c, products, releases };
}
