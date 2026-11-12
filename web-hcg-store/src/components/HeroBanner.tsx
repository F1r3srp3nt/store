import { useState } from "react";
import { assetUrl } from "../lib/format";

const SIZES = [800, 1200, 1774] as const;
const LARGEST = 1774;
const HEIGHT = 887;

/**
 * Founder-supplied HCG Store banner used as the home hero image.
 *
 * It is marketing artwork: the devices show a stylised store screen, not screenshots of real
 * apps, so it carries a visible "Illustration" label. It is the largest above-the-fold image, so
 * it loads eagerly. If it fails to load it is removed and the hero text remains.
 */
export function HeroBanner() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="hero-banner">
      <img
        className="hero-banner__img"
        src={assetUrl(`brand/hcg-store-banner-${LARGEST}.webp`)}
        srcSet={SIZES.map((w) => `${assetUrl(`brand/hcg-store-banner-${w}.webp`)} ${w}w`).join(", ")}
        sizes="(max-width: 1240px) 100vw, 1160px"
        width={LARGEST}
        height={HEIGHT}
        alt="HCG Store by Hakmi Capital Group: illustration of the HCG Store wordmark beside a laptop, tablet and phone showing a stylised store screen"
        loading="eager"
        fetchPriority="high"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <figcaption className="art-label">Illustration</figcaption>
    </figure>
  );
}
