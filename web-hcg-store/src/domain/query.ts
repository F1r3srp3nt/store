import type { Catalogue } from "./catalogue";
import { availability, type Availability } from "./model";
import type { Product } from "./schema";
import {
  CATEGORIES,
  CATEGORY_IDS,
  DEVELOPMENT_STATUS,
  DEVELOPMENT_STATUS_IDS,
  PLATFORMS,
  PLATFORM_IDS,
  type CategoryId,
  type DevelopmentStatus,
  type PlatformId,
} from "./taxonomy";

export type AvailabilityFilter = "any" | "downloadable" | "no-download";

export interface CatalogueQuery {
  q: string;
  platforms: PlatformId[];
  category: CategoryId | null;
  availability: AvailabilityFilter;
  status: DevelopmentStatus | null;
}

export const EMPTY_QUERY: CatalogueQuery = { q: "", platforms: [], category: null, availability: "any", status: null };

export const normalise = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function haystack(p: Product): { name: string; rest: string } {
  return {
    name: normalise(`${p.name} ${p.monogram}`),
    rest: normalise(
      [
        p.summary,
        ...p.description,
        ...p.tags,
        CATEGORIES[p.category].label,
        ...p.platforms.map((x) => PLATFORMS[x.platform].label),
      ].join(" "),
    ),
  };
}

/** Text search over name, summary, description, tags, category and platform labels. All terms must match. */
export function matchesText(p: Product, q: string): { match: boolean; nameHits: number } {
  const terms = normalise(q).split(/[^a-z0-9&+.#]+/).filter(Boolean);
  if (!terms.length) return { match: true, nameHits: 0 };
  const h = haystack(p);
  let nameHits = 0;
  for (const t of terms) {
    const inName = h.name.includes(t);
    if (inName) nameHits++;
    if (!inName && !h.rest.includes(t)) return { match: false, nameHits };
  }
  return { match: true, nameHits };
}

/** A product matches a platform when it is confirmed, in development or planned for it. */
export const matchesPlatforms = (p: Product, platforms: PlatformId[]): boolean =>
  platforms.length === 0 || p.platforms.some((x) => platforms.includes(x.platform));

export function matchesAvailability(a: Availability, f: AvailabilityFilter): boolean {
  if (f === "any") return true;
  if (f === "downloadable") return a === "downloadable";
  return a !== "downloadable";
}

export function filterProducts(c: Catalogue, query: CatalogueQuery): Product[] {
  const scored: { p: Product; nameHits: number; avail: Availability }[] = [];
  for (const p of c.products) {
    const t = matchesText(p, query.q);
    if (!t.match) continue;
    if (!matchesPlatforms(p, query.platforms)) continue;
    if (query.category && p.category !== query.category) continue;
    if (query.status && p.developmentStatus !== query.status) continue;
    const avail = availability(c, p);
    if (!matchesAvailability(avail, query.availability)) continue;
    scored.push({ p, nameHits: t.nameHits, avail });
  }
  return scored
    .sort(
      (a, b) =>
        b.nameHits - a.nameHits ||
        Number(b.avail === "downloadable") - Number(a.avail === "downloadable") ||
        a.p.name.localeCompare(b.p.name, "en"),
    )
    .map((x) => x.p);
}

// ---- URL <-> query (shareable, bookmarkable filters) ----

export function queryFromParams(params: URLSearchParams): CatalogueQuery {
  const platforms = (params.get("platform") ?? "")
    .split(",")
    .filter((x): x is PlatformId => (PLATFORM_IDS as string[]).includes(x));
  const category = params.get("category");
  const status = params.get("status");
  const avail = params.get("availability");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    platforms: [...new Set(platforms)],
    category: category && (CATEGORY_IDS as string[]).includes(category) ? (category as CategoryId) : null,
    status: status && (DEVELOPMENT_STATUS_IDS as string[]).includes(status) ? (status as DevelopmentStatus) : null,
    availability: avail === "downloadable" || avail === "no-download" ? avail : "any",
  };
}

export function paramsFromQuery(q: CatalogueQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q.trim()) p.set("q", q.q.trim());
  if (q.platforms.length) p.set("platform", q.platforms.join(","));
  if (q.category) p.set("category", q.category);
  if (q.status) p.set("status", q.status);
  if (q.availability !== "any") p.set("availability", q.availability);
  return p;
}

export const isEmptyQuery = (q: CatalogueQuery): boolean =>
  !q.q.trim() && !q.platforms.length && !q.category && !q.status && q.availability === "any";

export const statusLabel = (s: DevelopmentStatus) => DEVELOPMENT_STATUS[s].label;
