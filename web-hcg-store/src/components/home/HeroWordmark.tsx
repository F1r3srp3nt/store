import { useState } from "react";
import { assetUrl } from "../../lib/format";
import { useThemeId } from "../../theme/ThemeContext";

/**
 * The HCG STORE wordmark: the official HCG logo (unaltered artwork) beside the STORE lettering taken from the
 * approved banner, on a transparent background. The light theme (Quantum Frost) gets a variant with a softer glow
 * so it sits on a pale page; only the variant for the current theme is requested. The text "HCG Store" is always
 * in the heading for assistive technology, and becomes visible if the image cannot load.
 */
const VARIANTS = {
  dark: { width: 1440, height: 282 },
  light: { width: 1440, height: 276 },
} as const;

export function HeroWordmark() {
  const theme = useThemeId();
  const variant = theme === "frost" ? "light" : "dark";
  const [failed, setFailed] = useState<string | null>(null);
  const { width, height } = VARIANTS[variant];
  const src = (w: number) => assetUrl(`brand/hcg-store-wordmark-${variant}-${w}.webp`);
  const showImage = failed !== variant;
  return (
    <h1 id="hero-title" className={`hero3__title${showImage ? "" : " hero3__title--text"}`}>
      {showImage && (
        <img
          key={variant}
          className="hero3__wordmark"
          src={src(1440)}
          srcSet={`${src(720)} 720w, ${src(1440)} 1440w`}
          sizes="(max-width: 700px) calc(100vw - 32px), 640px"
          width={width}
          height={height}
          alt=""
          decoding="async"
          fetchPriority="high"
          onError={() => setFailed(variant)}
        />
      )}
      <span className={showImage ? "visually-hidden" : "hero3__brandline"}>HCG Store</span>
    </h1>
  );
}
