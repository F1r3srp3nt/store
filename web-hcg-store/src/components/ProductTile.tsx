import type { Product } from "../domain/schema";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Generated identification tile used when no real screenshot exists. It is abstract artwork,
 * not a screenshot and not an official product icon.
 */
export function ProductTile({ product, size = "card" }: { product: Product; size?: "card" | "hero" }) {
  const h = hash(product.id);
  const tilt = (h % 50) - 25;
  const tilt2 = ((h >> 8) % 60) - 30;
  const violet = product.category === "developer-tools" || (h >> 4) % 3 === 0;
  const accent = violet ? "var(--violet)" : "var(--cyan)";
  const gid = `tile-${product.id}`;
  return (
    <div className={`product-tile product-tile--${size}`} role="img" aria-label={`${product.name} identification tile (generated artwork, not a screenshot)`}>
      <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <radialGradient id={`${gid}-core`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={accent} stopOpacity="0.28" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${gid}-metal`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f4f8fd" />
            <stop offset="48%" stopColor="#c3cfdd" />
            <stop offset="54%" stopColor="#8e9cb0" />
            <stop offset="100%" stopColor="#dde6f0" />
          </linearGradient>
          <pattern id={`${gid}-grid`} width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M16 0H0V16" fill="none" stroke="rgba(130,196,255,0.07)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="320" height="200" fill="#08101f" />
        <rect width="320" height="200" fill={`url(#${gid}-grid)`} />
        <circle cx="160" cy="100" r="96" fill={`url(#${gid}-core)`} />
        <g fill="none" stroke={accent} strokeOpacity="0.5">
          <ellipse cx="160" cy="100" rx="118" ry="34" transform={`rotate(${tilt} 160 100)`} />
          <ellipse cx="160" cy="100" rx="92" ry="22" transform={`rotate(${tilt2} 160 100)`} strokeOpacity="0.3" />
        </g>
        <circle cx="160" cy="100" r="44" fill="#0a1428" stroke="rgba(200,225,255,0.25)" />
        <text
          x="160"
          y="100"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Space Grotesk Variable, Space Grotesk, system-ui, sans-serif"
          fontWeight="700"
          fontSize={product.monogram.length > 2 ? 26 : 32}
          letterSpacing="1"
          fill={`url(#${gid}-metal)`}
        >
          {product.monogram}
        </text>
      </svg>
    </div>
  );
}
