import { useState } from "react";
import { assetUrl } from "../lib/format";

const SIZES = [800, 1200, 2172] as const;
const LARGEST = 2172;
const HEIGHT = 724;
const srcSet = (ext: "avif" | "webp") => SIZES.map((w) => `${assetUrl(`brand/hcg-store-hero-${w}.${ext}`)} ${w}w`).join(", ");
const SIZES_ATTR = "(max-width: 1240px) 100vw, 1080px";

/**
 * The approved HCG Store banner (founder-supplied artwork, November 2026). Always shown in full at its own 3:1
 * aspect ratio — never cropped or stretched — so the "HCG STORE · A HAKMI CAPITAL GROUP PLATFORM" lettering
 * stays intact at every width. AVIF first, WebP fallback; it is marketing illustration, so it is labelled.
 */
export function HeroBanner() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="hero-banner">
      <picture>
        <source type="image/avif" srcSet={srcSet("avif")} sizes={SIZES_ATTR} />
        <img
          className="hero-banner__img"
          src={assetUrl(`brand/hcg-store-hero-${LARGEST}.webp`)}
          srcSet={srcSet("webp")}
          sizes={SIZES_ATTR}
          width={LARGEST}
          height={HEIGHT}
          alt="HCG Store, a Hakmi Capital Group platform: the chrome HCG STORE wordmark glowing blue and violet above a lit circular platform, with the night side of the Earth behind it"
          loading="eager"
          fetchPriority="high"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </picture>
      <figcaption className="art-label">Illustration</figcaption>
    </figure>
  );
}
