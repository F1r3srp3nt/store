/**
 * The HCG ecosystem graph, built only from catalogue facts: each product's stated `integrations`, its
 * `relatedProducts`, product families and merges (`supersededBy`). An edge is "available" only when the catalogue says
 * so, which validation allows only when both sides have an approved current release; everything else is "planned".
 */
import { INTEGRATION_SYSTEMS, type Catalogue } from "./catalogue";
import { currentRelease, listedProducts } from "./model";
import type { Product } from "./schema";

export type EcoNode =
  | { kind: "product"; id: string; label: string; product: Product; mergedFrom: string[] }
  | { kind: "system"; id: string; label: string; note: string };

export interface EcoEdge {
  from: string;
  to: string;
  status: "available" | "planned";
  relation: "integration" | "works-with" | "family";
  note: string;
}

const SYSTEMS: Record<string, { label: string; note: string }> = {
  "hcg-connect": { label: "HCG Connect", note: "HCG's account and licence service." },
  "hcg-repo": { label: "HCG Repo", note: "HCG's package repository for jailbroken devices." },
};

export function ecosystemGraph(c: Catalogue): { nodes: EcoNode[]; edges: EcoEdge[] } {
  const products = listedProducts(c).filter((p) => !p.supersededBy);
  const byId = new Map(c.products.map((p) => [p.id, p]));
  const edges: EcoEdge[] = [];
  const seen = new Set<string>();
  const add = (e: EcoEdge) => {
    const k = [e.from, e.to].sort().join("|"); // one edge per pair; stated integrations come first and win
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  };
  for (const p of products) {
    for (const i of p.integrations) add({ from: p.id, to: i.with, status: i.status, relation: "integration", note: i.note });
    for (const r of p.relatedProducts) {
      const o = byId.get(r);
      if (!o || o.visibility === "draft") continue;
      const both = !!currentRelease(c, p) && !!currentRelease(c, o);
      add({ from: p.id, to: r, status: both ? "available" : "planned", relation: "works-with", note: `${p.name} works with ${o.name}.` });
    }
  }
  // Merged products are shown as part of their successor, not as nodes.
  const mergedInto = new Map<string, string[]>();
  for (const p of c.products.filter((x) => x.supersededBy && x.visibility !== "draft")) mergedInto.set(p.supersededBy!, [...(mergedInto.get(p.supersededBy!) ?? []), p.name]);
  // Families with more than one listed member.
  const families = new Map<string, Product[]>();
  for (const p of products) if (p.family) families.set(p.family, [...(families.get(p.family) ?? []), p]);
  for (const members of families.values()) {
    for (let i = 1; i < members.length; i++) add({ from: members[0]!.id, to: members[i]!.id, status: "available", relation: "family", note: "Same product family." });
  }
  const usedSystems = new Set(edges.map((e) => e.to).filter((id) => INTEGRATION_SYSTEMS.includes(id)));
  const nodes: EcoNode[] = [
    ...[...usedSystems].map((id) => ({ kind: "system" as const, id, ...SYSTEMS[id]! })),
    ...products.map((p) => ({ kind: "product" as const, id: p.id, label: p.name, product: p, mergedFrom: mergedInto.get(p.id) ?? [] })),
  ];
  return { nodes, edges };
}

/** Connections of one node, both directions, for the details panel. */
export function connectionsOf(graph: { nodes: EcoNode[]; edges: EcoEdge[] }, id: string) {
  const label = (x: string) => graph.nodes.find((n) => n.id === x)?.label ?? x;
  return graph.edges
    .filter((e) => e.from === id || e.to === id)
    .map((e) => ({ ...e, other: e.from === id ? e.to : e.from, otherLabel: label(e.from === id ? e.to : e.from) }));
}
