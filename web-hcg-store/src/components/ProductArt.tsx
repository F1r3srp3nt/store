import { useState } from "react";
import type { ArtworkImage, Media, Product } from "../domain/schema";
import { assetUrl } from "../lib/format";
import { MediaImage } from "./MediaImage";

const ACCENTS: Record<Product["artwork"]["accent"], string> = {
  cyan: "var(--cyan)",
  violet: "var(--violet)",
  silver: "#d7dee8",
  mint: "var(--mint)",
  amber: "var(--amber)",
};

/** True when the product has real cover artwork or a real screenshot to show. */
export function hasVisualArt(product: Product): boolean {
  return !!product.artwork.cover || !!firstScreenshot(product);
}

/** The product's first real screenshot, if any. */
export function firstScreenshot(product: Product): Media | undefined {
  return product.media.find((m) => m.kind === "screenshot");
}

function srcSet(art: ArtworkImage, ext: ".webp" | ".avif"): string {
  return [...art.variants, { src: art.src, width: art.width }]
    .sort((a, b) => a.width - b.width)
    .map((v) => `${assetUrl(ext === ".avif" ? v.src.replace(/\.webp$/, ".avif") : v.src)} ${v.width}w`)
    .join(", ");
}

/**
 * Responsive catalogue artwork: AVIF where the browser supports it, WebP otherwise, with the
 * intrinsic size set so nothing shifts while it loads. `priority` is for the one above-the-fold
 * image on a page; everything else is lazy-loaded. `decorative` gives an empty alt for art placed
 * next to the product name, so screen readers do not announce the name twice.
 */
function ArtImg({
  art,
  sizes,
  className,
  priority = false,
  decorative = false,
}: {
  art: ArtworkImage;
  sizes: string;
  className: string;
  priority?: boolean;
  decorative?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const img = (
    <img
      className={className}
      src={assetUrl(art.src)}
      srcSet={art.variants.length ? srcSet(art, ".webp") : undefined}
      sizes={art.variants.length ? sizes : undefined}
      width={art.width}
      height={art.height}
      alt={decorative ? "" : art.alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding={priority ? "auto" : "async"}
      onError={() => setFailed(true)}
    />
  );
  if (!art.avif) return img;
  return (
    <picture className="art-picture">
      <source type="image/avif" srcSet={srcSet(art, ".avif")} sizes={art.variants.length ? sizes : undefined} />
      {img}
    </picture>
  );
}

/**
 * The product's icon, or (only when no approved icon exists) its monogram in brushed metal on
 * smoked glass. Decorative: the product name is always shown next to it.
 * App icons get the platform's rounded mask; "framed" icons already draw their own frame, so they
 * are shown whole, with no mask or extra ring.
 */
export function ProductMark({ product, size = "md" }: { product: Product; size?: "sm" | "md" | "lg" }) {
  const icon = product.artwork.icon;
  const accent = ACCENTS[product.artwork.accent];
  const framed = !!icon && product.artwork.iconStyle === "framed";
  return (
    <span
      className={`product-mark product-mark--${size}${icon ? " product-mark--icon" : ""}${framed ? " product-mark--framed" : ""}`}
      style={{ ["--accent" as string]: accent }}
      aria-hidden="true"
    >
      {icon ? (
        <ArtImg art={icon} sizes={size === "lg" ? "96px" : size === "md" ? "56px" : "44px"} className="product-mark__img" decorative />
      ) : (
        <span className="product-mark__monogram">{product.monogram}</span>
      )}
    </span>
  );
}

/**
 * Cover art for product cards, in order of preference:
 *   1. the product's approved banner, shown whole at its own aspect ratio (never cropped),
 *   2. a real screenshot in a consistent device frame (labelled "Screenshot"),
 *   3. the product icon or branded mark on a composed panel.
 * Invented interface imagery is never shown as a screenshot.
 */
export function ProductCover({ product, sizes, eager = false, showLabel = true }: { product: Product; sizes: string; eager?: boolean; showLabel?: boolean }) {
  const accent = ACCENTS[product.artwork.accent];
  const cover = product.artwork.cover;
  const shot = firstScreenshot(product);
  const style = { ["--accent" as string]: accent };

  if (cover) {
    return (
      <div className="product-cover product-cover--art" style={{ ...style, aspectRatio: `${cover.width} / ${cover.height}` }}>
        <ArtImg art={cover} sizes={sizes} priority={eager} className="product-cover__img" decorative />
        {showLabel && cover.kind === "concept" && <span className="art-label">Illustration</span>}
      </div>
    );
  }
  if (shot) {
    return (
      <div className="product-cover product-cover--shot" style={style}>
        <div className="screen-frame">
          <MediaImage media={shot} sizes={sizes} eager={eager} />
        </div>
        {showLabel && <span className="art-label">Screenshot</span>}
      </div>
    );
  }
  return (
    <div className="product-cover product-cover--mark" style={style}>
      <ProductMark product={product} size="lg" />
    </div>
  );
}

/**
 * The product's banner across the top of its detail page: the page's one high-priority image,
 * shown whole at its natural 3:1 ratio. Decorative, because it repeats the heading below it.
 */
export function ProductBanner({ product }: { product: Product }) {
  const cover = product.artwork.cover;
  if (!cover) return null;
  return (
    <div className="product-banner" style={{ aspectRatio: `${cover.width} / ${cover.height}` }}>
      <ArtImg art={cover} sizes="(max-width: 1240px) calc(100vw - 32px), 1180px" priority decorative className="product-banner__img" />
      {cover.kind === "concept" && <span className="art-label">Illustration</span>}
    </div>
  );
}
