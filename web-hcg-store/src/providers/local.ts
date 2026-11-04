import productsDoc from "@catalogue/products.json";
import releasesDoc from "@catalogue/releases.json";
import { validateCatalogue } from "../domain/catalogue";
import type { CatalogueProvider, CatalogueSource } from "./types";

const source: CatalogueSource = {
  providerId: "local",
  label: "Provisional local catalogue (repository seed data)",
  authority: "provisional",
};

/** Bundled, validated seed catalogue. Stand-in until the HCG ERP product registry contract exists. */
export const localCatalogueProvider: CatalogueProvider = {
  source,
  async load() {
    const r = validateCatalogue(productsDoc, releasesDoc);
    return r.ok
      ? { ok: true, catalogue: r.catalogue, warnings: r.warnings, source }
      : { ok: false, reason: "invalid", message: "The bundled catalogue failed validation.", details: r.errors, source };
  },
};
