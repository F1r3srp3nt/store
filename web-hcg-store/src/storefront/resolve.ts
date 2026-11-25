/**
 * Storefront configuration (catalogue/storefront.json): which listed products the hero spotlights and features, and
 * the order of homepage sections. Reviewed and deployed like the catalogue: administrators change it by pull request.
 * It can only point at products the catalogue lists; it never sets a price, release or availability.
 */
import { z } from "zod";
import type { Catalogue } from "../domain/catalogue";
import { listedProducts } from "../domain/model";
import type { Product } from "../domain/schema";

export const SECTION_IDS = [
  "new-releases", "recently-updated", "featured", "categories", "upcoming", "ecosystem", "developer-tools", "security",
  "infrastructure", "productivity", "unleashed", "news", "campaigns",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const StorefrontSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  hero: z.strictObject({ spotlight: z.array(kebab).max(8).default([]), rotateSeconds: z.number().int().min(4).max(30).default(7) }),
  featured: z.array(kebab).max(8).default([]),
  sections: z.array(z.enum(SECTION_IDS)).default([...SECTION_IDS]),
});
export type StorefrontDoc = z.infer<typeof StorefrontSchema>;

export interface Storefront {
  spotlight: Product[];
  rotateSeconds: number;
  featured: Product[];
  sections: SectionId[];
  warnings: string[];
}

/** Resolves product IDs against the catalogue: unknown, draft or merged products are dropped with a warning. */
export function resolveStorefront(c: Catalogue, doc: unknown): Storefront {
  const parsed = StorefrontSchema.safeParse(doc);
  const warnings: string[] = [];
  const d: StorefrontDoc = parsed.success ? parsed.data : { schemaVersion: 1, hero: { spotlight: [], rotateSeconds: 7 }, featured: [], sections: [...SECTION_IDS] };
  if (!parsed.success) warnings.push(...parsed.error.issues.map((i) => `storefront.json ${i.path.join(".")}: ${i.message}`));
  const listed = new Map(listedProducts(c).filter((p) => !p.supersededBy).map((p) => [p.id, p]));
  const pick = (ids: string[], where: string) =>
    [...new Set(ids)].flatMap((id) => {
      const p = listed.get(id);
      if (!p) warnings.push(`storefront.json ${where}: "${id}" is not a listed product; ignored.`);
      return p ? [p] : [];
    });
  return { spotlight: pick(d.hero.spotlight, "hero.spotlight"), rotateSeconds: d.hero.rotateSeconds, featured: pick(d.featured, "featured"), sections: [...new Set(d.sections)], warnings };
}
