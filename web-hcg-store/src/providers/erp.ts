import { validateCatalogue } from "../domain/catalogue";
import type { CatalogueLoadResult, CatalogueProvider, CatalogueSource } from "./types";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * Reads the catalogue from a PUBLIC, read-only HCG ERP endpoint.
 *
 * PROPOSED contract (pending founder/central review, see docs/HCG-INTEGRATION.md):
 *   GET <VITE_HCG_ERP_CATALOGUE_URL>  →  { "schemaVersion": 1, "products": [...], "releases": [...] }
 * using the same item schema as the local files. No credentials are sent from the browser.
 */
export function createErpCatalogueProvider(endpoint: string | undefined, fetchImpl: typeof fetch = fetch): CatalogueProvider {
  const source: CatalogueSource = { providerId: "hcg-erp", label: "HCG ERP product registry", authority: "central" };
  const fail = (reason: "not-configured" | "unreachable" | "invalid", message: string, details: string[] = []): CatalogueLoadResult => ({
    ok: false,
    reason,
    message,
    details,
    source,
  });

  return {
    source,
    async load(signal) {
      if (!endpoint) return fail("not-configured", "HCG ERP catalogue endpoint not configured (VITE_HCG_ERP_CATALOGUE_URL).");
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        return fail("not-configured", "VITE_HCG_ERP_CATALOGUE_URL is not a valid URL.");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        return fail("not-configured", "VITE_HCG_ERP_CATALOGUE_URL must be an https URL without credentials.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      signal?.addEventListener("abort", () => controller.abort());
      try {
        const res = await fetchImpl(url.toString(), {
          method: "GET",
          credentials: "omit",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) return fail("unreachable", `HCG ERP catalogue responded with HTTP ${res.status}.`);
        const length = Number(res.headers.get("content-length") ?? "0");
        if (length > MAX_BYTES) return fail("invalid", "HCG ERP catalogue response is unexpectedly large.");
        const body = (await res.json()) as { schemaVersion?: unknown; products?: unknown; releases?: unknown };
        const v = validateCatalogue(
          { schemaVersion: body.schemaVersion, products: body.products },
          { schemaVersion: body.schemaVersion, releases: body.releases },
        );
        return v.ok
          ? { ok: true, catalogue: v.catalogue, warnings: v.warnings, source }
          : fail("invalid", "HCG ERP catalogue did not match the expected schema.", v.errors);
      } catch (e) {
        return fail("unreachable", "HCG ERP catalogue could not be reached.", [e instanceof Error ? e.message : String(e)]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
