import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Catalogue } from "../../domain/catalogue";
import { connectionsOf, ecosystemGraph, type EcoNode } from "../../domain/ecosystem";
import { availability } from "../../domain/model";
import { CATEGORIES } from "../../domain/taxonomy";
import { assetUrl } from "../../lib/format";
import { StatusPill } from "../Badges";
import { IconArrowRight } from "../Icons";
import { ACCENT_RGB, ProductMark } from "../ProductArt";

const W = 720;
const H = 440;

/** Deterministic layout: HCG systems in the middle, products on an ellipse grouped by category. */
function layout(nodes: EcoNode[]) {
  const systems = nodes.filter((n) => n.kind === "system");
  const products = nodes
    .filter((n): n is Extract<EcoNode, { kind: "product" }> => n.kind === "product")
    .sort((a, b) => a.product.category.localeCompare(b.product.category) || a.label.localeCompare(b.label));
  const pos = new Map<string, { x: number; y: number }>();
  systems.forEach((n, i) => pos.set(n.id, { x: W / 2 + (i - (systems.length - 1) / 2) * 150, y: H / 2 }));
  products.forEach((n, i) => {
    const a = (i / products.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: W / 2 + Math.cos(a) * 300, y: H / 2 + Math.sin(a) * 175 });
  });
  return pos;
}

/**
 * HCG ecosystem explorer: registered products and HCG systems as connected nodes. Built only from catalogue facts
 * (domain/ecosystem.ts). The list of buttons is the accessible interface; the constellation mirrors it visually.
 */
export function EcosystemExplorer({ catalogue }: { catalogue: Catalogue }) {
  const graph = useMemo(() => ecosystemGraph(catalogue), [catalogue]);
  const pos = useMemo(() => layout(graph.nodes), [graph]);
  const firstConnected = graph.nodes.find((n) => n.kind === "product" && graph.edges.some((e) => e.from === n.id || e.to === n.id));
  const [selected, setSelected] = useState<string>(firstConnected?.id ?? graph.nodes[0]?.id ?? "");
  if (graph.nodes.length < 2) return null;
  const node = graph.nodes.find((n) => n.id === selected) ?? graph.nodes[0]!;
  const links = connectionsOf(graph, node.id);
  const linked = new Set(links.map((l) => l.other));

  return (
    <div className="eco">
      <div className="eco__map" aria-hidden="true">
        <svg viewBox={`0 0 ${W} ${H}`} className="eco__svg" role="presentation">
          <ellipse cx={W / 2} cy={H / 2} rx={300} ry={175} className="eco__ring" />
          <ellipse cx={W / 2} cy={H / 2} rx={190} ry={110} className="eco__ring eco__ring--inner" />
          {graph.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const on = e.from === node.id || e.to === node.id;
            const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.12;
            const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.12;
            return (
              <path
                key={`${e.from}-${e.to}-${e.relation}`}
                d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                className={`eco__edge eco__edge--${e.status}${on ? " eco__edge--on" : ""}`}
              />
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const on = n.id === node.id;
            const near = linked.has(n.id);
            const icon = n.kind === "product" ? n.product.artwork.icon : null;
            return (
              <g key={n.id} className={`eco__node eco__node--${n.kind}${on ? " eco__node--on" : ""}${near ? " eco__node--near" : ""}`} transform={`translate(${p.x} ${p.y})`}>
                <circle r={n.kind === "system" ? 30 : 24} className="eco__halo" />
                {icon ? (
                  <image href={assetUrl(icon.src)} x={-18} y={-18} width={36} height={36} clipPath="inset(0 round 9px)" />
                ) : (
                  <text className="eco__mono" textAnchor="middle" dy="0.35em">
                    {n.kind === "product" ? n.product.monogram : n.label.replace("HCG ", "")}
                  </text>
                )}
                <text className="eco__label" textAnchor="middle" y={n.kind === "system" ? 48 : 42}>
                  {n.label.replace(/^HCG /, "")}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="eco__legend">
          <span className="eco__key eco__key--available" /> Available now <span className="eco__key eco__key--planned" /> Planned or in development
        </p>
      </div>

      <div className="eco__panel">
        <ul className="eco__nodes" aria-label="Products and HCG systems">
          {graph.nodes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`eco__chip${n.id === node.id ? " eco__chip--on" : ""}`}
                aria-pressed={n.id === node.id}
                onClick={() => setSelected(n.id)}
                style={n.kind === "product" ? { ["--card-accent-rgb" as string]: ACCENT_RGB[n.product.artwork.accent] } : undefined}
              >
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="eco__detail holo-border" aria-live="polite">
          {node.kind === "product" ? (
            <div className="eco__detail-head">
              <ProductMark product={node.product} size="md" />
              <div>
                <p className="eco__detail-kicker">{CATEGORIES[node.product.category].label}</p>
                <h3 className="eco__detail-title">{node.label}</h3>
              </div>
              <StatusPill status={node.product.developmentStatus} availability={availability(catalogue, node.product)} />
            </div>
          ) : (
            <div className="eco__detail-head">
              <div>
                <p className="eco__detail-kicker">HCG system</p>
                <h3 className="eco__detail-title">{node.label}</h3>
                <p className="eco__detail-note">{node.note}</p>
              </div>
            </div>
          )}
          {links.length ? (
            <ul className="eco__links">
              {links.map((l) => (
                <li key={`${l.other}-${l.relation}`} className={`eco__link eco__link--${l.status}`}>
                  <span className={`eco__status eco__status--${l.status}`}>{l.status === "available" ? "Available" : "Planned"}</span>
                  <span>
                    <strong>{l.otherLabel}</strong> · {l.note}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="eco__detail-note">No integrations with other HCG products are stated for {node.label} yet.</p>
          )}
          {node.kind === "product" && node.mergedFrom.length > 0 && <p className="eco__detail-note">Includes {node.mergedFrom.join(" and ")}, which is now part of it.</p>}
          {node.kind === "product" && (
            <Link to={`/apps/${node.product.slug}`} className="text-link">
              Open {node.label} <IconArrowRight />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
