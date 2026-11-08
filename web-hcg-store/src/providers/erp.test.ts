import { describe, expect, it, vi } from "vitest";
import { raw } from "../test/fixtures";
import { createErpCatalogueProvider } from "./erp";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("HCG ERP catalogue provider", () => {
  it("reports not-configured without making a request", async () => {
    const f = vi.fn();
    const r = await createErpCatalogueProvider(undefined, f).load();
    expect(r).toMatchObject({ ok: false, reason: "not-configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses non-https endpoints and endpoints with credentials", async () => {
    for (const url of ["http://erp.example/catalogue", "https://u:p@erp.example/catalogue"]) {
      const f = vi.fn();
      expect(await createErpCatalogueProvider(url, f).load()).toMatchObject({ ok: false, reason: "not-configured" });
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("reads and validates a catalogue, preserving IDs, without sending credentials", async () => {
    const f = vi.fn(async () =>
      json({ schemaVersion: 1, products: raw.fixtureProducts.products, releases: raw.fixtureReleases.releases }),
    );
    const r = await createErpCatalogueProvider("https://erp.example/api/public/store/catalogue", f as unknown as typeof fetch).load();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.authority).toBe("central");
      expect(r.catalogue.products.map((p) => p.id)).toEqual(raw.fixtureProducts.products.map((p) => p.id));
    }
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("GET");
  });

  it("rejects responses that do not match the schema instead of showing them", async () => {
    const f = vi.fn(async () => json({ schemaVersion: 1, products: [{ id: "x" }], releases: [] }));
    const r = await createErpCatalogueProvider("https://erp.example/c", f as unknown as typeof fetch).load();
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reports HTTP and network failures", async () => {
    const http = vi.fn(async () => json({}, { status: 503 }));
    expect(await createErpCatalogueProvider("https://erp.example/c", http as unknown as typeof fetch).load()).toMatchObject({ ok: false, reason: "unreachable" });
    const net = vi.fn(async () => {
      throw new TypeError("network down");
    });
    expect(await createErpCatalogueProvider("https://erp.example/c", net as unknown as typeof fetch).load()).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
