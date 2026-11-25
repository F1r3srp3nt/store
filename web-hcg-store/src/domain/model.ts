import type { Catalogue } from "./catalogue";
import type { Product, Release } from "./schema";
import { compareSemver } from "./version";

/**
 * Public release availability. "released" means HCG has designated an approved current release.
 * Under the current release policy every file is delivered only after sign-in and a server-side
 * access check, so "released" never means "publicly downloadable".
 */
export type Availability = "released" | "coming-soon";

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  released: "Release approved",
  "coming-soon": "Coming soon",
};

/** The product with this stable ID (account and purchase records refer to products by ID). */
export function findProductById(c: Catalogue, id: string): Product | undefined {
  return c.products.find((p) => p.id === id);
}

export function findProductBySlug(c: Catalogue, slug: string): Product | undefined {
  return c.products.find((p) => p.slug === slug);
}

/** All releases of a product, newest first by Semantic Versioning precedence. */
export function releaseHistory(c: Catalogue, product: Product): Release[] {
  return c.releases.filter((r) => r.productId === product.id).sort((a, b) => compareSemver(b.version, a.version));
}

/** The explicitly designated current release. Never inferred from version numbers or dates. */
export function currentRelease(c: Catalogue, product: Product): Release | null {
  if (!product.currentReleaseId) return null;
  const r = c.releases.find((x) => x.id === product.currentReleaseId);
  return r && r.status === "approved" && r.productId === product.id ? r : null;
}

export type ReleaseRole = "current" | "previous" | "approved-not-current" | "withdrawn";

export function releaseRole(c: Catalogue, product: Product, release: Release): ReleaseRole {
  if (release.status === "withdrawn") return "withdrawn";
  const cur = currentRelease(c, product);
  if (cur?.id === release.id) return "current";
  if (cur && compareSemver(release.version, cur.version) < 0) return "previous";
  return "approved-not-current";
}

export const RELEASE_ROLE_LABELS: Record<ReleaseRole, string> = {
  current: "Current approved release",
  previous: "Previous release",
  "approved-not-current": "Approved — not designated current",
  withdrawn: "Withdrawn",
};

export function availability(c: Catalogue, product: Product): Availability {
  return currentRelease(c, product) ? "released" : "coming-soon";
}

/** HCG Repo product page for a Store product, optionally for one edition. */
export function hcgRepoLinks(product: Product, editionId?: string | null) {
  return product.hcgRepo.filter((l) => editionId === undefined || l.editionId === null || l.editionId === editionId);
}

/** Products shown in listings: everything except products merged into another one and draft entries. */
export function listedProducts(c: Catalogue): Product[] {
  return c.products.filter((p) => !p.supersededBy && p.visibility !== "draft");
}

export function successorOf(c: Catalogue, product: Product): Product | null {
  return product.supersededBy ? (c.products.find((p) => p.id === product.supersededBy) ?? null) : null;
}

/** Related products the catalogue names, in its order; drafts and merged products are left out. */
export function relatedProductsOf(c: Catalogue, product: Product): Product[] {
  return product.relatedProducts
    .map((id) => c.products.find((p) => p.id === id))
    .filter((p): p is Product => !!p && p.visibility !== "draft" && !p.supersededBy);
}

export function inCollection(c: Catalogue, collection: Product["collections"][number]): Product[] {
  return listedProducts(c).filter((p) => p.collections.includes(collection));
}

// ---- v3 homepage sections. Each returns only products the data supports; an empty list hides the section. ----

/** Listed products whose current release (explicit currentReleaseId) is approved, newest release first. */
export function newReleases(c: Catalogue): { product: Product; release: Release }[] {
  return listedProducts(c)
    .flatMap((p) => {
      const r = currentRelease(c, p);
      return r ? [{ product: p, release: r }] : [];
    })
    .sort((a, b) => (b.release.releaseDate ?? "").localeCompare(a.release.releaseDate ?? ""));
}

/** Listed products with any approved release in the catalogue, by their latest approved release date. */
export function recentlyUpdated(c: Catalogue): { product: Product; release: Release }[] {
  const latest = new Map<string, Release>();
  for (const r of c.releases) {
    if (r.status !== "approved" || !r.releaseDate) continue;
    const prev = latest.get(r.productId);
    if (!prev || (prev.releaseDate ?? "") < r.releaseDate) latest.set(r.productId, r);
  }
  return listedProducts(c)
    .flatMap((p) => (latest.has(p.id) ? [{ product: p, release: latest.get(p.id)! }] : []))
    .sort((a, b) => (b.release.releaseDate ?? "").localeCompare(a.release.releaseDate ?? ""));
}

/** Being built, tested or planned, with no approved current release. */
export function upcomingProducts(c: Catalogue): Product[] {
  return listedProducts(c).filter(
    (p) => !p.supersededBy && !currentRelease(c, p) && ["in-development", "testing", "planning"].includes(p.developmentStatus),
  );
}

/** Products with an Unleashed tier or a jailbreak-package edition. */
export function unleashedProducts(c: Catalogue): Product[] {
  return listedProducts(c).filter((p) => !p.supersededBy && p.editions.some((e) => e.tier === "unleashed" || e.channel === "jailbreak-package"));
}

export function productsInCategory(c: Catalogue, category: Product["category"]): Product[] {
  return listedProducts(c).filter((p) => !p.supersededBy && p.category === category);
}
