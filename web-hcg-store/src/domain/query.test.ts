import { describe, expect, it } from "vitest";
import { fixtureCatalogue, realCatalogue } from "../test/fixtures";
import { EMPTY_QUERY, filterProducts, paramsFromQuery, queryFromParams, type CatalogueQuery } from "./query";

const q = (patch: Partial<CatalogueQuery>): CatalogueQuery => ({ ...EMPTY_QUERY, ...patch });
const ids = (c: ReturnType<typeof realCatalogue>, query: CatalogueQuery) => filterProducts(c, query).map((p) => p.id);

describe("search and filters (shipped catalogue)", () => {
  const c = realCatalogue();

  it("returns everything for an empty query", () => {
    expect(filterProducts(c, EMPTY_QUERY)).toHaveLength(c.products.length);
  });

  it("searches names case- and accent-insensitively and ranks name hits first", () => {
    expect(ids(c, q({ q: "MAIL" }))[0]).toBe("hcg-mail");
    expect(ids(c, q({ q: "máil" }))[0]).toBe("hcg-mail");
  });

  it("searches descriptions and tags", () => {
    expect(ids(c, q({ q: "imap" }))).toEqual(["hcg-mail"]);
    expect(ids(c, q({ q: "checksums" }))).toContain("hcg-executable-maker");
    expect(ids(c, q({ q: "order flow simulated" }))).toEqual(["hcg-one-unleashed"]);
  });

  it("requires all terms to match", () => {
    expect(ids(c, q({ q: "mail trading" }))).toEqual([]);
  });

  it("filters by platform (including in-development/planned support)", () => {
    expect(ids(c, q({ platforms: ["ios"] }))).toEqual(["hcg-cardx"]);
    expect(ids(c, q({ platforms: ["windows"] })).sort()).toEqual(["hcg-executable-maker", "hcg-mail"]);
    expect(ids(c, q({ platforms: ["android"] }))).toEqual([]);
  });

  it("filters by category", () => {
    expect(ids(c, q({ category: "developer-tools" })).sort()).toEqual(["hcg-executable-maker", "hcg-reprompter", "hcg-terminal", "hcg-virtualisation"]);
  });

  it("filters by release availability", () => {
    expect(ids(c, q({ availability: "downloadable" }))).toEqual([]);
    expect(ids(c, q({ availability: "no-download" }))).toHaveLength(c.products.length);
  });

  it("combines filters", () => {
    expect(ids(c, q({ q: "build", category: "developer-tools", platforms: ["linux"], status: "in-development" }))).toEqual(["hcg-executable-maker"]);
  });
});

describe("availability filter with releases (fixture)", () => {
  const c = fixtureCatalogue();
  it("separates downloadable products from the rest", () => {
    expect(ids(c, q({ availability: "downloadable" })).sort()).toEqual(["fixture-orbit-notes", "fixture-pocket-relay"]);
    expect(ids(c, q({ availability: "no-download" })).sort()).toEqual(["fixture-nebula-pad", "fixture-signal-desk"]);
  });
  it("lists downloadable products before others when not searching", () => {
    const order = ids(c, EMPTY_QUERY);
    expect(order.slice(0, 2).sort()).toEqual(["fixture-orbit-notes", "fixture-pocket-relay"]);
  });
});

describe("URL parameters", () => {
  it("round-trips a query", () => {
    const query = q({ q: "mail", platforms: ["windows", "macos"], category: "communication", status: "in-development", availability: "no-download" });
    expect(queryFromParams(paramsFromQuery(query))).toEqual(query);
  });
  it("ignores unknown or hostile values", () => {
    const parsed = queryFromParams(new URLSearchParams("platform=windows,amiga,<script>&category=evil&availability=all&status=x"));
    expect(parsed).toEqual(q({ platforms: ["windows"] }));
  });
});
