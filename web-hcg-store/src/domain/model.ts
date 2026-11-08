import type { Catalogue } from "./catalogue";
import type { Artifact, Product, Release } from "./schema";
import { compareSemver } from "./version";
import { DOWNLOAD_PROVIDERS } from "../downloads/providers";

export type Availability = "downloadable" | "release-info-only" | "none";

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  downloadable: "Download available",
  "release-info-only": "Release announced — no download supplied",
  none: "No public release supplied",
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

export interface ResolvedDownload {
  artifact: Artifact;
  href: string;
  providerLabel: string;
  disclosure: string;
}

export function resolveDownload(release: Release, artifact: Artifact): ResolvedDownload | null {
  if (release.status !== "approved" || !artifact.download) return null;
  const provider = DOWNLOAD_PROVIDERS[artifact.download.provider];
  const r = provider.resolve(artifact.download.url);
  return r.ok ? { artifact, href: r.href, providerLabel: provider.label, disclosure: provider.disclosure } : null;
}

export function downloadableArtifacts(release: Release): ResolvedDownload[] {
  return release.artifacts.map((a) => resolveDownload(release, a)).filter((d): d is ResolvedDownload => d !== null);
}

export function availability(c: Catalogue, product: Product): Availability {
  const cur = currentRelease(c, product);
  if (!cur) return "none";
  return downloadableArtifacts(cur).length > 0 ? "downloadable" : "release-info-only";
}
