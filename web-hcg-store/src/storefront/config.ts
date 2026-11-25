/** The shipped storefront configuration (catalogue/storefront.json), resolved against the catalogue. See resolve.ts. */
import storefrontDoc from "@catalogue/storefront.json";
import type { Catalogue } from "../domain/catalogue";
import { resolveStorefront as resolve, type Storefront } from "./resolve";

export { SECTION_IDS, StorefrontSchema, type SectionId, type Storefront } from "./resolve";

export function resolveStorefront(c: Catalogue, doc: unknown = storefrontDoc): Storefront {
  return resolve(c, doc);
}
