/**
 * HCG Representation: approved, versioned brand assets (product icons, banners, logos, theme definitions, background
 * artwork, promotional images, design tokens). The Store consumes a manifest when one is configured and otherwise
 * uses the local files it ships with. Local files are always the fallback: a missing, invalid or unapproved manifest
 * entry never removes an image, and a manifest can only point at same-origin paths (the CSP allows 'self').
 *
 * Not active: VITE_HCG_REPRESENTATION_MANIFEST is unset, so `representationAsset` returns the local path.
 */
import { z } from "zod";

const sameOrigin = z.string().regex(/^\/(?!\/)[A-Za-z0-9._~\/-]+$/, "Representation assets must be same-origin paths.");
const Entry = z.strictObject({ src: sameOrigin, version: z.string().min(1), approvedAt: z.string() });

export const RepresentationManifestSchema = z.strictObject({
  format: z.literal("hcg.representation.manifest/1"),
  version: z.string().min(1),
  productIcons: z.record(z.string(), Entry).default({}),
  banners: z.record(z.string(), Entry).default({}),
  logos: z.record(z.string(), Entry).default({}),
  backgrounds: z.record(z.string(), Entry).default({}),
  promos: z.record(z.string(), Entry).default({}),
  /** Theme definitions and design tokens: only CSS custom properties named in the Store's token list are applied. */
  themes: z.record(z.string(), z.record(z.string().regex(/^--[a-z0-9-]+$/), z.string().max(200))).default({}),
});
export type RepresentationManifest = z.infer<typeof RepresentationManifestSchema>;
export type AssetKind = "productIcons" | "banners" | "logos" | "backgrounds" | "promos";

let manifest: RepresentationManifest | null = null;

/** Loads the manifest once (only when configured). Failures leave the local assets in place. */
export async function loadRepresentation(url = import.meta.env.VITE_HCG_REPRESENTATION_MANIFEST as string | undefined): Promise<RepresentationManifest | null> {
  if (!url || !/^\/(?!\/)/.test(url)) return null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const r = RepresentationManifestSchema.safeParse(await res.json());
    manifest = r.success ? r.data : null;
  } catch {
    manifest = null;
  }
  return manifest;
}

export function setRepresentationManifest(m: RepresentationManifest | null) {
  manifest = m;
}

/** The approved Representation asset for `id`, or the local fallback. */
export function representationAsset(kind: AssetKind, id: string, localFallback: string): string {
  return manifest?.[kind][id]?.src ?? localFallback;
}
