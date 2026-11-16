import { useState } from "react";
import { assetUrl } from "../lib/format";

const SIZES = [800, 1200, 2000] as const;
const LARGEST = 2000;
const HEIGHT = 667;

/**
 * The approved HCG Store banner (founder-supplied artwork). Always shown in full at its own 3:1
 * aspect ratio — never cropped — so the "HCG STORE · HAKMI CAPITAL GROUP" lettering stays intact.
 * It is marketing illustration (the app icons in it are not screenshots), so it is labelled.
 */
export function HeroBanner() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="hero-banner">
      <img
        className="hero-banner__img"
        src={assetUrl(`brand/hcg-store-hero-${LARGEST}.webp`)}
        srcSet={SIZES.map((w) => `${assetUrl(`brand/hcg-store-hero-${w}.webp`)} ${w}w`).join(", ")}
        sizes="(max-width: 1240px) 100vw, 1160px"
        width={LARGEST}
        height={HEIGHT}
        alt="HCG Store by Hakmi Capital Group: the chrome HCG Store wordmark beside glowing glass app tiles for a terminal, security, mail and layers, above a lit platform with a tablet and phone"
        loading="eager"
        fetchPriority="high"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <figcaption className="art-label">Illustration</figcaption>
    </figure>
  );
}
