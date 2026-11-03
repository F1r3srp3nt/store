import { assetUrl } from "../lib/format";

/**
 * Abstract orbital / network motif for the home hero. Pure SVG + CSS; the only motion is a slow
 * rotation that stops entirely under prefers-reduced-motion.
 */
export function OrbitalHero() {
  const nodes = [
    [70, 210],
    [140, 96],
    [300, 60],
    [436, 130],
    [470, 268],
    [380, 392],
    [210, 420],
    [96, 340],
  ] as const;
  return (
    <div className="orbital" aria-hidden="true">
      <svg viewBox="0 0 540 480" className="orbital__svg">
        <defs>
          <radialGradient id="orb-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#3ee6ff" stopOpacity="0.32" />
            <stop offset="55%" stopColor="#3ee6ff" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#3ee6ff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="orb-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3ee6ff" stopOpacity="0.75" />
            <stop offset="50%" stopColor="#c3cfdd" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#a48bff" stopOpacity="0.6" />
          </linearGradient>
        </defs>
        <circle cx="270" cy="240" r="210" fill="url(#orb-core)" />
        {/* network mesh */}
        <g className="orbital__mesh" stroke="rgba(130,196,255,0.16)" strokeWidth="1">
          {nodes.map(([x, y], i) => {
            const [nx, ny] = nodes[(i + 3) % nodes.length]!;
            return <line key={`l${i}`} x1={x} y1={y} x2={nx} y2={ny} />;
          })}
          {nodes.map(([x, y], i) => (
            <line key={`c${i}`} x1={x} y1={y} x2={270} y2={240} strokeOpacity="0.5" />
          ))}
        </g>
        <g className="orbital__rings" fill="none" stroke="url(#orb-ring)">
          <ellipse cx="270" cy="240" rx="230" ry="78" transform="rotate(-18 270 240)" strokeWidth="1.2" />
          <ellipse cx="270" cy="240" rx="182" ry="58" transform="rotate(24 270 240)" strokeWidth="1" strokeOpacity="0.7" />
          <ellipse cx="270" cy="240" rx="128" ry="128" strokeWidth="0.8" strokeDasharray="2 7" strokeOpacity="0.6" />
        </g>
        <g className="orbital__spin">
          <circle cx="500" cy="240" r="4" fill="#3ee6ff" />
          <circle cx="40" cy="240" r="3" fill="#a48bff" />
          <circle cx="270" cy="112" r="2.5" fill="#c3cfdd" />
        </g>
        <g>
          {nodes.map(([x, y], i) => (
            <circle key={`n${i}`} cx={x} cy={y} r={i % 3 === 0 ? 3.5 : 2.5} fill={i % 4 === 1 ? "#a48bff" : "#3ee6ff"} fillOpacity="0.85" />
          ))}
        </g>
        <circle cx="270" cy="240" r="86" fill="#08101f" stroke="rgba(200,225,255,0.22)" />
        <circle cx="270" cy="240" r="96" fill="none" stroke="rgba(62,230,255,0.18)" />
      </svg>
      <img className="orbital__mark" src={assetUrl("brand/hcg-mark-480.webp")} width={480} height={218} alt="" />
    </div>
  );
}
