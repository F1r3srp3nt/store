/**
 * Server-rendered <head> for product pages (/apps/<slug>), so search engines and link previews see the product's real
 * title, description, image and SoftwareApplication data without running the app's JavaScript.
 *
 * Facts come from the catalogue and HCG Store's live published releases: version, operating system, price (only when
 * the edition is free: 0 NOK), status. Never ratings, reviews or download counts, and never a file URL.
 */
import type { Catalogue } from "../../src/domain/catalogue";
import type { Product } from "../../src/domain/schema";

export interface LiveRelease {
  version: string;
  channel: string;
  files: { platform: string; architectures: string[]; minimumOs: string | null }[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON inside <script>: no "</" sequence can close the element. */
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const OS_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux", ios: "iOS", ipados: "iPadOS", android: "Android" };

export function productHead(opts: { catalogue: Catalogue; slug: string; origin: string; live: LiveRelease[] }): string | null {
  const product = opts.catalogue.products.find((p) => p.slug === opts.slug && p.visibility !== "draft" && !p.supersededBy);
  if (!product) return null;
  const url = `${opts.origin}/apps/${product.slug}`;
  const release = opts.live[0] ?? null;
  const free = product.editions.some((e) => e.pricingModel === "free");
  const landing = product.landing;
  const status = release ? (release.channel === "beta" ? `Public Beta ${release.version}` : `Version ${release.version}`) : null;
  const osList = release ? [...new Set(release.files.map((f) => `${OS_NAMES[f.platform] ?? f.platform}${f.architectures.length ? ` (${f.architectures.join(", ")})` : ""}`))] : [];
  const title = landing && release ? `${product.name}: ${landing.headline.replace(/\.$/, "")}` : product.name;
  const description = landing && release
    ? `${landing.tagline} ${status} for ${osList.join(" and ")}${free ? ". Free download, no account required." : "."}`.replace(/\s+/g, " ")
    : product.summary;
  const imagePath = landing?.ogImage ?? product.artwork.cover?.src ?? null;
  const image = imagePath ? `${opts.origin}/${imagePath}` : null;
  const icon = product.artwork.icon ? `${opts.origin}/${product.artwork.icon.src}` : null;

  const tags = [
    `<title>${esc(`${title} · HCG Store`)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="HCG Store" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    ...(image ? [`<meta property="og:image" content="${esc(image)}" />`, `<meta property="og:image:alt" content="${esc(`${product.name} by Hakmi Capital Group`)}" />`] : []),
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    ...(image ? [`<meta name="twitter:image" content="${esc(image)}" />`] : []),
  ];
  if (release) {
    const data: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: product.name,
      description: landing?.tagline ?? product.summary,
      url,
      applicationCategory: product.category === "communication" ? "CommunicationApplication" : "BusinessApplication",
      operatingSystem: osList.join(", "),
      softwareVersion: release.version,
      ...(icon ? { image: icon } : {}),
      ...(free ? { offers: { "@type": "Offer", price: "0", priceCurrency: "NOK", url } } : {}),
      publisher: { "@type": "Organization", name: "Hakmi Capital Group" },
    };
    tags.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  }
  return tags.join("\n    ");
}

/** Replaces the default <title> and description of the built index.html with a product's head. */
export function withProductHead(indexHtml: string, head: string): string {
  return indexHtml
    .replace(/<title>[^<]*<\/title>/, "")
    .replace(/<meta name="description"[^>]*>/, "")
    .replace("</head>", `    ${head}\n  </head>`);
}

export type { Product };
