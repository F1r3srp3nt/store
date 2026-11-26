/**
 * Server-side registries: the catalogue (public, shared with the web app), offers (prices) and
 * protected artifacts. Offers and artifacts live ONLY on the server, so a browser can never
 * choose a price or a file location.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { validateCatalogue, type Catalogue } from "../../src/domain/catalogue";
import type { Edition, Product, Release } from "../../src/domain/schema";

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const centralId = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);

export const OfferSchema = z.strictObject({
  id: kebab,
  /** Store catalogue product ID. */
  productId: kebab,
  /** Must equal the product's confirmed central HCG product ID (registry.centralId). */
  centralProductId: centralId,
  /** Edition being sold. Null only for products without editions. */
  editionId: kebab.nullable(),
  title: z.string().min(1),
  kind: z.enum(["one-time", "subscription"]),
  interval: z.enum(["month", "year"]).nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Price in the currency's minor unit (e.g. cents). */
  unitAmount: z.number().int().positive(),
  /**
   * What a verified purchase grants. Each entry is an edition of the same central product, or "*"
   * for every edition — only when the configured licence explicitly says so.
   */
  grants: z
    .array(
      z.strictObject({
        edition: z.union([kebab, z.literal("*")]),
        /**
         * Central feature keys of the product this purchase includes (e.g. "download" once HCG registers it, D3),
         * listed explicitly; nothing is implied. Staff permissions (store.*) can never be sold.
         */
        features: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)).optional(),
      }),
    )
    .min(1),
  status: z.enum(["draft", "approved-for-sale"]),
  /** Test-mode offers are ignored outside test mode. */
  testOnly: z.boolean(),
});
export type Offer = z.infer<typeof OfferSchema>;

/** HCG Store's staff permissions (store.publish, store.release.approve, …): HCG grants them per person, never a purchase. */
export const STAFF_PERMISSION = /^store\./;

export const ProtectedArtifactSchema = z.strictObject({
  /** Globally unique ID used in /api/v1/downloads/<id>. */
  id: kebab,
  productId: kebab,
  releaseId: kebab,
  /** The artifact's ID inside the catalogue release. */
  catalogueArtifactId: kebab,
  editionId: kebab.nullable(),
  fileName: z.string().regex(/^[^/\\\u0000-\u001f]+$/),
  contentType: z.string().default("application/octet-stream"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Path inside the private storage directory. Never a URL. */
  storageKey: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+$/),
  /** Separate from catalogue approval: delivery approval for this exact file. */
  deliveryApproved: z.boolean(),
  testOnly: z.boolean(),
});
export type ProtectedArtifact = z.infer<typeof ProtectedArtifactSchema>;

export interface Registry {
  catalogue: Catalogue;
  offers: Offer[];
  artifacts: ProtectedArtifact[];
  warnings: string[];
  /** Releases published through Ship to Store and MANUALLY approved for public delivery (server/src/publishing.ts). */
  published?: PublishedSource;
}

export interface PublishedSource {
  publishedFor(productId: string, editionId: string | null): ProtectedArtifact[];
  /** Of those, the files of releases approved as public AND free: any signed-in HCG account may download them. */
  freePublicFor(productId: string, editionId: string | null): ProtectedArtifact[];
  /** The open free testing window of this edition (when it ends), if any. Public information, no account data. */
  freeWindowFor?(productId: string, editionId: string | null): { endsAt: number; releaseId: string | null } | null;
  publishedById(id: string): ProtectedArtifact | undefined;
  publishedMeta(id: string): { version: string; architectures: string[] } | undefined;
}

/** A deliverable file by ID: the static registry first, then approved Ship to Store releases. */
export function findArtifact(reg: Registry, id: string): ProtectedArtifact | undefined {
  return reg.artifacts.find((a) => a.id === id) ?? reg.published?.publishedById(id);
}

export class RegistryError extends Error {
  constructor(public readonly problems: string[]) {
    super(`HCG Store registry invalid:\n- ${problems.join("\n- ")}`);
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

export function loadRegistry(opts: { catalogueDir: string; offersFile: string; artifactsFile: string; testMode: boolean }): Registry {
  const result = validateCatalogue(readJson(join(opts.catalogueDir, "products.json")), readJson(join(opts.catalogueDir, "releases.json")));
  if (!result.ok) throw new RegistryError(result.errors);
  const offersDoc = z.strictObject({ $comment: z.string().optional(), offers: z.array(OfferSchema) }).parse(readJson(opts.offersFile));
  const artifactsDoc = z
    .strictObject({ $comment: z.string().optional(), artifacts: z.array(ProtectedArtifactSchema) })
    .parse(readJson(opts.artifactsFile));
  return buildRegistry(result.catalogue, offersDoc.offers, artifactsDoc.artifacts, opts.testMode);
}

export function buildRegistry(catalogue: Catalogue, offers: Offer[], artifacts: ProtectedArtifact[], testMode: boolean): Registry {
  const problems: string[] = [];
  const warnings: string[] = [];
  const products = new Map(catalogue.products.map((p) => [p.id, p]));
  const releases = new Map(catalogue.releases.map((r) => [r.id, r]));

  const usable = (x: { testOnly: boolean; id: string }, what: string) => {
    if (x.testOnly && !testMode) {
      warnings.push(`${what} "${x.id}" is test-only and is ignored outside test mode.`);
      return false;
    }
    return true;
  };

  const seenOffers = new Set<string>();
  const liveOffers = offers.filter((o) => usable(o, "Offer"));
  for (const o of liveOffers) {
    if (seenOffers.has(o.id)) problems.push(`Duplicate offer id "${o.id}".`);
    seenOffers.add(o.id);
    const p = products.get(o.productId);
    if (!p) {
      problems.push(`Offer "${o.id}" references unknown product "${o.productId}".`);
      continue;
    }
    if (p.registry.centralId !== o.centralProductId) {
      problems.push(`Offer "${o.id}": centralProductId "${o.centralProductId}" is not the product's confirmed central ID.`);
    }
    if (p.editions.length && !o.editionId) problems.push(`Offer "${o.id}" must name an edition of "${p.id}".`);
    if (o.editionId && !p.editions.some((e) => e.id === o.editionId)) problems.push(`Offer "${o.id}" references unknown edition "${o.editionId}".`);
    for (const g of o.grants) {
      if (g.edition !== "*" && !p.editions.some((e) => e.id === g.edition) && !(p.editions.length === 0 && g.edition === "default")) {
        problems.push(`Offer "${o.id}" grants unknown edition "${g.edition}".`);
      }
      const features = g.features ?? [];
      for (const f of features) {
        if (STAFF_PERMISSION.test(f)) problems.push(`Offer "${o.id}" grants "${f}": publishing and approval permissions are never sold.`);
      }
      if (new Set(features).size !== features.length) problems.push(`Offer "${o.id}" lists a feature twice.`);
      const granted = p.editions.find((e) => e.id === g.edition);
      if (granted && !granted.centralEditionKey) {
        // D2: HCG checks editions by their central key; an unmapped edition could never be checked.
        problems.push(`Offer "${o.id}" grants edition "${g.edition}", which has no central edition key.`);
      }
    }
    if ((o.kind === "subscription") !== (o.interval !== null)) problems.push(`Offer "${o.id}": subscriptions need an interval, one-time offers must not have one.`);
    if (o.status === "approved-for-sale" && !releasedEdition(catalogue, p, o.editionId)) {
      // No preorder policy exists, so an unreleased product or edition is never charged for.
      problems.push(`Offer "${o.id}" is approved for sale, but "${p.id}" has no approved current release for that edition. Preorders are not supported.`);
    }
  }

  const seenArtifacts = new Set<string>();
  const liveArtifacts = artifacts.filter((a) => usable(a, "Protected artifact"));
  for (const a of liveArtifacts) {
    if (seenArtifacts.has(a.id)) problems.push(`Duplicate protected artifact id "${a.id}".`);
    seenArtifacts.add(a.id);
    const rel = releases.get(a.releaseId);
    if (!rel || rel.productId !== a.productId) {
      problems.push(`Protected artifact "${a.id}" references unknown release "${a.releaseId}" of "${a.productId}".`);
      continue;
    }
    const ca = rel.artifacts.find((x) => x.id === a.catalogueArtifactId);
    if (!ca) problems.push(`Protected artifact "${a.id}" references unknown catalogue artifact "${a.catalogueArtifactId}".`);
    else {
      if (ca.fileName !== a.fileName) problems.push(`Protected artifact "${a.id}" file name differs from the catalogue ("${ca.fileName}").`);
      if (ca.editionId !== a.editionId) problems.push(`Protected artifact "${a.id}" edition differs from the catalogue.`);
      if (ca.sha256 && ca.sha256 !== a.sha256) problems.push(`Protected artifact "${a.id}" SHA-256 differs from the catalogue.`);
    }
  }

  if (problems.length) throw new RegistryError(problems);
  return { catalogue, offers: liveOffers, artifacts: liveArtifacts, warnings };
}

/** The approved, designated current release of a product (never inferred from version numbers). */
export function currentReleaseOf(c: Catalogue, product: Product): Release | null {
  if (!product.currentReleaseId) return null;
  const r = c.releases.find((x) => x.id === product.currentReleaseId);
  return r && r.status === "approved" && r.productId === product.id ? r : null;
}

function releasedEdition(c: Catalogue, product: Product, editionId: string | null): boolean {
  const cur = currentReleaseOf(c, product);
  if (!cur) return false;
  return editionId === null || cur.artifacts.some((a) => a.editionId === editionId);
}

export function findProduct(reg: Registry, idOrSlug: string): Product | undefined {
  return reg.catalogue.products.find((p) => p.id === idOrSlug || p.slug === idOrSlug);
}

export function findEdition(product: Product, editionId: string | null | undefined): Edition | null {
  if (!editionId) return null;
  return product.editions.find((e) => e.id === editionId) ?? null;
}

/** HCG Repo product key → Store product and edition, from the catalogue's explicit mapping. */
export function findByRepoKey(reg: Registry, key: string): { product: Product; editionId: string | null } | null {
  for (const p of reg.catalogue.products) {
    const link = p.hcgRepo.find((l) => l.key === key);
    if (link) return { product: p, editionId: link.editionId };
  }
  return null;
}

/** Debian package identifier → Store product and edition. */
export function findByPackageId(reg: Registry, packageId: string): { product: Product; edition: Edition } | null {
  for (const p of reg.catalogue.products) {
    for (const e of p.editions) {
      if (e.identifiers.some((i) => i.kind === "debian-package" && i.value === packageId)) return { product: p, edition: e };
    }
  }
  return null;
}

/** Approved, sellable offers for a product edition. */
export function offersFor(reg: Registry, product: Product, editionId: string | null): Offer[] {
  return reg.offers.filter((o) => o.productId === product.id && o.editionId === editionId && o.status === "approved-for-sale");
}

/** Edition key used for entitlements. Products without editions use "default". */
export function editionKey(editionId: string | null | undefined): string {
  return editionId ?? "default";
}
