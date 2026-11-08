import { useState, type ReactNode } from "react";
import type { Media } from "../domain/schema";
import { assetUrl } from "../lib/format";

interface Props {
  media: Media;
  sizes: string;
  eager?: boolean;
  /** Rendered if the image fails to load. Defaults to a text placeholder that keeps the alt text visible. */
  fallback?: ReactNode;
}

/** Responsive, lazy-loaded image with an explicit, readable failure state. */
export function MediaImage({ media, sizes, eager = false, fallback }: Props) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      fallback ?? (
        <div className="media-missing" role="img" aria-label={`Image unavailable: ${media.alt}`}>
          <span className="media-missing__title">Image unavailable</span>
          <span className="media-missing__alt">{media.alt}</span>
        </div>
      )
    );
  }
  const variants = [...media.variants, { src: media.src, width: media.width }].sort((a, b) => a.width - b.width);
  return (
    <img
      className="media-image"
      src={assetUrl(media.src)}
      srcSet={variants.map((v) => `${assetUrl(v.src)} ${v.width}w`).join(", ")}
      sizes={sizes}
      width={media.width}
      height={media.height}
      alt={media.alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
