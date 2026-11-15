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

/** Products shown in listings: everything except products merged into another one. */
export function listedProducts(c: Catalogue): Product[] {
  return c.products.filter((p) => !p.supersededBy);
}

export function successorOf(c: Catalogue, product: Product): Product | null {
  return product.supersededBy ? (c.products.find((p) => p.id === product.supersededBy) ?? null) : null;
}

export function inCollection(c: Catalogue, collection: Product["collections"][number]): Product[] {
  return listedProducts(c).filter((p) => p.collections.includes(collection));
}
