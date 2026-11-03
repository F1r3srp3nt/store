import type { Catalogue } from "../domain/catalogue";

export type CatalogueProviderId = "local" | "hcg-erp";

export interface CatalogueSource {
  providerId: CatalogueProviderId;
  /** Human-readable description of where the data came from. */
  label: string;
  /** "provisional" = local seed data in this repository; "central" = read from HCG ERP. */
  authority: "provisional" | "central";
}

export type CatalogueLoadResult =
  | { ok: true; catalogue: Catalogue; warnings: string[]; source: CatalogueSource }
  | { ok: false; reason: "not-configured" | "unreachable" | "invalid"; message: string; details: string[]; source: CatalogueSource };

/**
 * Read-only access to the product catalogue. Implementations must never write to the central
 * registry; the storefront only reads.
 */
export interface CatalogueProvider {
  readonly source: CatalogueSource;
  load(signal?: AbortSignal): Promise<CatalogueLoadResult>;
}
