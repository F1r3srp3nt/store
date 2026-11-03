import realProducts from "../../catalogue/products.json";
import realReleases from "../../catalogue/releases.json";
import fixtureProducts from "../../tests/fixtures/catalogue-demo/products.json";
import fixtureReleases from "../../tests/fixtures/catalogue-demo/releases.json";
import { validateCatalogue, type Catalogue } from "../domain/catalogue";
import type { CatalogueProvider } from "../providers/types";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const raw = { realProducts, realReleases, fixtureProducts, fixtureReleases };

function load(p: unknown, r: unknown): Catalogue {
  const v = validateCatalogue(p, r);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.catalogue;
}
export const realCatalogue = (): Catalogue => load(realProducts, realReleases);
export const fixtureCatalogue = (): Catalogue => load(fixtureProducts, fixtureReleases);

export const staticProvider = (catalogue: Catalogue): CatalogueProvider => ({
  source: { providerId: "local", label: "Test catalogue", authority: "provisional" },
  load: async () => ({ ok: true, catalogue, warnings: [], source: { providerId: "local", label: "Test catalogue", authority: "provisional" } }),
});
