import { assetUrl } from "../lib/format";

/**
 * The background engine: atmosphere, holographic grid, circuitry, the HCG emblem, energy lines, particles, orbital
 * geometry and a metallic sheen, all themed by tokens. Decorative only (aria-hidden, no pointer events), fixed
 * behind the page, CSS-only: every animation is a transform or opacity change on its own layer, and all of it stops
 * under prefers-reduced-motion or when the visitor switches effects off (styles/effects.css).
 */
export function AmbientBackground({ variant = "default" }: { variant?: "default" | "quiet" }) {
  return (
    <div className={`ambient ambient--${variant}`} aria-hidden="true">
      <div className="ambient__atmos" />
      <div className="ambient__sheen" />
      <div className="ambient__circuit" />
      <div className="ambient__grid">
        <div className="ambient__grid-plane" />
      </div>
      <img className="ambient__emblem" src={assetUrl("brand/hcg-mark-480.webp")} alt="" width={480} height={218} decoding="async" loading="lazy" />
      <svg className="ambient__orbit" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice">
        <g>
          <ellipse cx="400" cy="400" rx="380" ry="140" />
          <ellipse cx="400" cy="400" rx="300" ry="300" className="ambient__orbit-dashed" />
          <ellipse cx="400" cy="400" rx="220" ry="80" transform="rotate(32 400 400)" />
          <circle cx="780" cy="400" r="4" className="ambient__orbit-node" />
          <circle cx="400" cy="100" r="3" className="ambient__orbit-node" />
        </g>
      </svg>
      <div className="ambient__particles ambient__particles--a" />
      <div className="ambient__particles ambient__particles--b" />
      <div className="ambient__energy ambient__energy--1" />
      <div className="ambient__energy ambient__energy--2" />
      <div className="ambient__energy ambient__energy--3" />
    </div>
  );
}
