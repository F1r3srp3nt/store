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

function ArtImg({ art, sizes, eager, className }: { art: ArtworkImage; sizes: string; eager?: boolean; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className={className}
      src={assetUrl(art.src)}
      srcSet={
        art.variants.length
          ? [...art.variants, { src: art.src, width: art.width }]
              .sort((a, b) => a.width - b.width)
              .map((v) => `${assetUrl(v.src)} ${v.width}w`)
              .join(", ")
          : undefined
      }
      width={art.width}
      height={art.height}
      alt={art.alt}
      sizes={sizes}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Branded fallback used only when no approved icon or artwork exists for a product: the product's
 * monogram in brushed metal on smoked glass, with the product's accent edge. Decorative: the
 * product name is always shown next to it.
 */
export function ProductMark({ product, size = "md" }: { product: Product; size?: "sm" | "md" | "lg" }) {
  const icon = product.artwork.icon;
  const accent = ACCENTS[product.artwork.accent];
  return (
    <span className={`product-mark product-mark--${size}`} style={{ ["--accent" as string]: accent }} aria-hidden={icon ? undefined : true}>
      {icon ? (
        <ArtImg art={{ ...icon, alt: "" }} sizes="96px" className="product-mark__img" />
      ) : (
        <span className="product-mark__monogram">{product.monogram}</span>
      )}
    </span>
  );
}

/**
 * Cover art for cards and product pages, in order of preference:
 *   1. approved cover artwork (concept illustrations are labelled),
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
    // The frame takes the artwork's own aspect ratio, so banners are shown complete, never cropped.
    return (
      <div className="product-cover product-cover--art" style={{ ...style, aspectRatio: `${cover.width} / ${cover.height}` }}>
        <ArtImg art={cover} sizes={sizes} eager={eager} className="product-cover__img" />
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
