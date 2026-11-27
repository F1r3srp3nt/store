import { describe, expect, it } from "vitest";
import { ecosystemGraph } from "../domain/ecosystem";
import { newReleases, recentlyUpdated, unleashedProducts, upcomingProducts } from "../domain/model";
import { validateCatalogue } from "../domain/catalogue";
import { clone, raw, realCatalogue } from "../test/fixtures";
import { resolveStorefront, SECTION_IDS } from "./config";
import { eligiblePlacements, validAnnouncements } from "./placements";
import { RepresentationManifestSchema, representationAsset, setRepresentationManifest } from "./representation";

const c = realCatalogue();

describe("storefront configuration", () => {
  it("the shipped storefront.json resolves with no warnings to listed products only", () => {
    const s = resolveStorefront(c);
    expect(s.warnings).toEqual([]);
    expect(s.spotlight.length).toBeGreaterThan(0);
    for (const p of [...s.spotlight, ...s.featured]) expect(p.visibility).toBe("listed");
    expect(new Set(s.sections)).toEqual(new Set(SECTION_IDS));
  });

  it("ignores drafts, merged and unknown products, and never fails the page on a bad file", () => {
    const s = resolveStorefront(c, { schemaVersion: 1, hero: { spotlight: ["hcg-ads", "hcg-reprompter", "nope", "hcg-server"] }, featured: ["hcg-ads"], sections: ["featured"] });
    expect(s.spotlight.map((p) => p.id)).toEqual(["hcg-server"]);
    expect(s.featured).toEqual([]);
    expect(s.warnings).toHaveLength(4);
    const bad = resolveStorefront(c, { schemaVersion: 2, price: 10 });
    expect(bad.spotlight).toEqual([]);
    expect(bad.warnings.length).toBeGreaterThan(0);
  });
});

describe("homepage sections come only from catalogue data", () => {
  it("lists only what HCG Store published, and upcoming products honestly", () => {
    expect(newReleases(c).map((x) => [x.product.id, x.release.version])).toEqual([["hcg-mail", "1.0.0-beta.1"]]);
    expect(recentlyUpdated(c).map((x) => [x.product.id, x.release.version])).toEqual([["hcg-mail", "1.0.0-beta.1"]]);
    const upcoming = upcomingProducts(c).map((p) => p.id);
    expect(upcoming).toContain("hcg-server");
    expect(upcoming).not.toContain("hcg-reprompter"); // merged into Clarity
    expect(upcoming.some((id) => c.products.find((p) => p.id === id)!.visibility === "draft")).toBe(false);
    expect(unleashedProducts(c).map((p) => p.id).sort()).toEqual(["hcg-nexus", "hcg-terminal"]);
  });
});

describe("ecosystem explorer", () => {
  it("draws only stated integrations, all planned while nothing is released, and never shows drafts", () => {
    const g = ecosystemGraph(c);
    expect(g.nodes.map((n) => n.id)).not.toContain("hcg-ads");
    expect(g.nodes.map((n) => n.id)).not.toContain("hcg-reprompter");
    expect(g.edges.every((e) => e.status === "planned")).toBe(true);
    const pairs = g.edges.map((e) => `${e.from}>${e.to}`);
    expect(pairs).toContain("hcg-sentinel>hcg-server");
    expect(pairs).toContain("hcg-server>hcg-executable-maker");
    expect(pairs.filter((p) => p === "hcg-server>hcg-executable-maker")).toHaveLength(1); // integration and related, once
    const clarity = g.nodes.find((n) => n.id === "hcg-clarity")!;
    expect(clarity.kind === "product" && clarity.mergedFrom).toEqual(["HCG RePrompter"]);
  });

  it("refuses an 'available' integration unless both sides have an approved current release", () => {
    const p = clone(raw.realProducts) as { products: Record<string, unknown>[] };
    const server = p.products.find((x) => x.id === "hcg-server")!;
    server.integrations = [{ with: "hcg-executable-maker", status: "available", note: "x" }];
    const r = validateCatalogue(p, raw.realReleases);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toMatch(/available.*approved current release/);
    server.integrations = [{ with: "hcg-ads", status: "planned", note: "x" }];
    expect(!validateCatalogue(p, raw.realReleases).ok).toBe(true); // a draft has no page
  });
});

describe("HCG ADS and HCG News contracts", () => {
  const ok = {
    id: "p1", slot: "home-campaign", kind: "campaign", title: "Launch", body: "Text", cta: { label: "Open", href: "/apps/hcg-server" },
    sponsored: false, approval: { id: "ads-1", approvedAt: "2026-11-01T00:00:00Z" },
  };
  it("keeps only approved, running, safe placements for the slot", () => {
    const now = Date.parse("2026-11-25T00:00:00Z");
    const list = [
      ok,
      { ...ok, id: "p2", slot: "sponsored" },
      { ...ok, id: "p3", approval: undefined },
      { ...ok, id: "p4", cta: { label: "x", href: "javascript:alert(1)" } },
      { ...ok, id: "p5", cta: { label: "x", href: "//evil.example/" } },
      { ...ok, id: "p6", endsAt: "2026-11-24T00:00:00Z" },
      { ...ok, id: "p7", startsAt: "2026-12-01T00:00:00Z" },
      { ...ok, id: "p8", body: null },
      { ...ok, id: "p9", fabricatedViews: 1000 },
    ];
    expect(eligiblePlacements({ placements: list }, "home-campaign", now).map((p) => p.id)).toEqual(["p1"]);
    expect(eligiblePlacements(null, "home-campaign", now)).toEqual([]);
  });
  it("sorts valid announcements newest first and drops malformed ones", () => {
    const a = validAnnouncements({
      announcements: [
        { id: "a", title: "Old", summary: "", publishedAt: "2026-10-01", href: "/apps" },
        { id: "b", title: "New", summary: "", publishedAt: "2026-11-01", href: "https://news.example/x" },
        { id: "c", title: "Bad", summary: "", publishedAt: "2026-11-02", href: "data:text/html,x" },
      ],
    });
    expect(a.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("HCG Representation", () => {
  it("uses local assets unless an approved same-origin manifest entry exists", () => {
    expect(representationAsset("productIcons", "hcg-server", "media/local.webp")).toBe("media/local.webp");
    const m = RepresentationManifestSchema.parse({ format: "hcg.representation.manifest/1", version: "1", productIcons: { "hcg-server": { src: "/rep/v1/server.webp", version: "1", approvedAt: "2026-11-01" } } });
    setRepresentationManifest(m);
    expect(representationAsset("productIcons", "hcg-server", "media/local.webp")).toBe("/rep/v1/server.webp");
    expect(representationAsset("banners", "hcg-server", "media/b.webp")).toBe("media/b.webp");
    setRepresentationManifest(null);
    expect(() => RepresentationManifestSchema.parse({ format: "hcg.representation.manifest/1", version: "1", logos: { x: { src: "https://cdn.example/x.png", version: "1", approvedAt: "x" } } })).toThrow();
  });
});
