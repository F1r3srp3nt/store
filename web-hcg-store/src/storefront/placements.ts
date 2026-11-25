/**
 * HCG ADS placements and HCG News announcements: the Store's side of the central contracts. HCG Store runs no
 * advertising engine of its own: it only shows creatives the central HCG ADS service has approved for a slot, and
 * articles HCG News has published. Until those services exist (VITE_STORE_PLACEMENTS is not "enabled"), nothing is
 * requested and every slot stays empty, so the homepage collapses those sections. Nothing here is ever invented.
 *
 * Expected same-origin endpoints (served or proxied by the Store server, so the CSP stays 'self'):
 *   GET /api/v1/placements?slot=<slot>   → { placements: Placement[] }
 *   GET /api/v1/announcements            → { announcements: Announcement[] }
 */
import { z } from "zod";

export const SLOTS = ["home-hero", "home-campaign", "product-launch", "news-promo", "sponsored"] as const;
export type Slot = (typeof SLOTS)[number];

/** Internal links, or https links (no credentials). Never javascript:, data: or protocol-relative URLs. */
const href = z.string().refine((u) => /^\/(?!\/)/.test(u) || /^https:\/\/[^/@\s]+\//.test(u + "/"), "Use a path on this site or an https URL.");
const asset = z.string().refine((u) => /^\/(?!\/)/.test(u) || /^https:\/\//.test(u), "Use a path on this site or an https URL.");

export const PlacementSchema = z.strictObject({
  id: z.string().min(1).max(80),
  slot: z.enum(SLOTS),
  kind: z.enum(["featured-product", "campaign", "product-launch", "news", "sponsored"]),
  title: z.string().min(1).max(120),
  body: z.string().max(280).nullable().default(null),
  cta: z.strictObject({ label: z.string().min(1).max(40), href }),
  productId: z.string().nullable().default(null),
  media: z
    .strictObject({
      image: z.strictObject({ src: asset, srcset: z.string().max(2000).nullable().default(null), alt: z.string().max(200), width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
      video: z.strictObject({ src: asset, poster: asset.nullable().default(null), captions: asset.nullable().default(null) }).nullable().default(null),
    })
    .default({ image: null, video: null }),
  /** Paid or partner placement: always labelled "Sponsored". Internal HCG promotions are labelled "HCG". */
  sponsored: z.boolean(),
  /** The central HCG ADS approval this creative carries; a placement without one is never shown. */
  approval: z.strictObject({ id: z.string().min(1), approvedAt: z.string() }),
  startsAt: z.string().nullable().default(null),
  endsAt: z.string().nullable().default(null),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const AnnouncementSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  summary: z.string().max(320),
  publishedAt: z.string(),
  href,
  productIds: z.array(z.string()).default([]),
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const placementsEnabled = () => import.meta.env.VITE_STORE_PLACEMENTS === "enabled";

/** Keeps only valid, approved, currently running placements for the slot. Invalid entries are dropped, not repaired. */
export function eligiblePlacements(raw: unknown, slot: Slot, now = Date.now()): Placement[] {
  const list = Array.isArray((raw as { placements?: unknown })?.placements) ? (raw as { placements: unknown[] }).placements : [];
  return list.flatMap((x) => {
    const r = PlacementSchema.safeParse(x);
    if (!r.success || r.data.slot !== slot) return [];
    const p = r.data;
    if (p.startsAt && Date.parse(p.startsAt) > now) return [];
    if (p.endsAt && Date.parse(p.endsAt) <= now) return [];
    if (!p.media.image && !p.media.video && !p.body) return [];
    return [p];
  });
}

export function validAnnouncements(raw: unknown): Announcement[] {
  const list = Array.isArray((raw as { announcements?: unknown })?.announcements) ? (raw as { announcements: unknown[] }).announcements : [];
  return list
    .flatMap((x) => {
      const r = AnnouncementSchema.safeParse(x);
      return r.success ? [r.data] : [];
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
  return res.json();
}

export async function loadPlacements(slot: Slot): Promise<Placement[]> {
  if (!placementsEnabled()) return [];
  try {
    return eligiblePlacements(await getJson(`/api/v1/placements?slot=${encodeURIComponent(slot)}`), slot);
  } catch {
    return [];
  }
}

export async function loadAnnouncements(): Promise<Announcement[]> {
  if (!placementsEnabled()) return [];
  try {
    return validAnnouncements(await getJson("/api/v1/announcements")).slice(0, 6);
  } catch {
    return [];
  }
}
