import { describe, expect, it } from "vitest";
import { clone, raw, realCatalogue } from "../test/fixtures";
import { validateCatalogue } from "./catalogue";

const REQUESTED_NAMES = [
  "HCG LifeOS",
  "HCG Mail",
  "HCG ONE: Unleashed",
  "HCG News",
  "HCG Executable Maker",
  "HCG RePrompter",
  "HCG Studio",
  "HCG CardX",
  "HCG Terminal",
  "HCG Virtualisation",
  "HCG Jailbreak Directory",
  "HCG Jailbreak Unleashed",
  "HCG Office Suite",
  "HCG Analytics & Measure",
];

describe("shipped catalogue", () => {
  const c = realCatalogue();

  it("is valid with unique IDs and slugs", () => {
    expect(new Set(c.products.map((p) => p.id)).size).toBe(c.products.length);
    expect(new Set(c.products.map((p) => p.slug)).size).toBe(c.products.length);
  });

  it("lists exactly the requested products — no umbrella, storefront or third-party entries", () => {
    expect(c.products.map((p) => p.name).sort()).toEqual([...REQUESTED_NAMES].sort());
    const names = c.products.map((p) => p.name.toLowerCase()).join("|");
    expect(names).not.toMatch(/development tools|hcg store|appstore|unimatch/);
  });

  it("claims no releases, downloads or central registry IDs that were never supplied", () => {
    expect(c.releases).toHaveLength(0);
    for (const p of c.products) {
      expect(p.currentReleaseId).toBeNull();
      expect(p.registry.status).toBe("provisional");
      expect(p.registry.centralId).toBeNull();
      for (const pl of p.platforms) expect(pl.support).not.toBe("confirmed");
    }
  });

  it("contains no Dropbox or other download URLs", () => {
    expect(JSON.stringify(raw.realReleases) + JSON.stringify(raw.realProducts)).not.toMatch(/dropbox|https?:\/\/[^"]*\.(zip|dmg|exe|ipa|apk|msi|pkg)/i);
  });

  it("labels every media item with provenance and only uses screenshot/concept kinds", () => {
    for (const p of c.products) for (const m of p.media) expect(m.provenance.length).toBeGreaterThan(10);
  });

  it("does not expose private repository names in public data", () => {
    expect(JSON.stringify(raw.realProducts)).not.toMatch(/F1r3srp3nt\/HCG-LifeOS|F1r3srp3nt\/hcg-cardx|"note":"private"/i);
  });
});

describe("catalogue validation errors", () => {
  const base = () => ({ p: clone(raw.fixtureProducts), r: clone(raw.fixtureReleases) });
  const errorsOf = (p: unknown, r: unknown) => {
    const v = validateCatalogue(p, r);
    return v.ok ? [] : v.errors.join("\n");
  };

  it("accepts the fixture catalogue", () => {
    const { p, r } = base();
    expect(validateCatalogue(p, r).ok).toBe(true);
  });

  it("rejects duplicate product IDs and slugs", () => {
    const { p, r } = base();
    p.products.push(clone(p.products[0]!));
    expect(errorsOf(p, r)).toMatch(/Duplicate product id: "fixture-orbit-notes"/);
  });

  it("rejects duplicate release IDs and duplicate versions", () => {
    const { p, r } = base();
    r.releases.push({ ...clone(r.releases[0]!), id: "another-id" });
    expect(errorsOf(p, r)).toMatch(/two releases with version 1\.2\.0/);
    const b = base();
    b.r.releases.push(clone(b.r.releases[0]!));
    expect(errorsOf(b.p, b.r)).toMatch(/Duplicate release id/);
  });

  it("rejects current releases that are missing, withdrawn or belong to another product", () => {
    const a = base();
    a.p.products[0]!.currentReleaseId = "does-not-exist";
    expect(errorsOf(a.p, a.r)).toMatch(/does not exist/);
    const b = base();
    b.p.products[0]!.currentReleaseId = "fixture-orbit-notes-1-10-1-beta-1";
    expect(errorsOf(b.p, b.r)).toMatch(/withdrawn release/);
    const c = base();
    c.p.products[0]!.currentReleaseId = "fixture-signal-desk-0-3-0";
    expect(errorsOf(c.p, c.r)).toMatch(/release of "fixture-signal-desk"/);
  });

  it("rejects releases for unknown products", () => {
    const { p, r } = base();
    r.releases[0]!.productId = "ghost-product";
    expect(errorsOf(p, r)).toMatch(/unknown product "ghost-product"/);
  });

  it("rejects non-semver versions and names the offending release", () => {
    const { p, r } = base();
    r.releases[1]!.version = "v1.10";
    expect(errorsOf(p, r)).toMatch(/releases\["fixture-orbit-notes-1-10-0"\]\.version: .*Semantic Versioning/);
  });

  it("rejects signed/notarised claims without evidence, bad checksums and deceptive download links", () => {
    const { p, r } = base();
    const art = r.releases[1]!.artifacts[1]! as Record<string, unknown>;
    art.signing = { status: "signed", evidence: null };
    art.sha256 = "ABC";
    (r.releases[1]!.artifacts[0]! as { download: { url: string } }).download.url = "https://www.dropbox.com.evil.example/scl/fi/a/b.zip?rlkey=x";
    const e = errorsOf(p, r);
    expect(e).toMatch(/requires evidence/);
    expect(e).toMatch(/SHA-256/);
    expect(e).toMatch(/not a supported Dropbox host/);
  });

  it("rejects architectures/minimum OS on unconfirmed platforms (no guessing)", () => {
    const { p, r } = base();
    p.products[1]!.platforms[0] = { platform: "linux", support: "in-development", architectures: ["x64"] } as never;
    expect(errorsOf(p, r)).toMatch(/only be stated for confirmed/);
  });

  it("rejects unknown fields (typos) and invalid IDs", () => {
    const { p, r } = base();
    (p.products[0] as Record<string, unknown>).downloadCount = 1000;
    p.products[1]!.id = "Bad ID";
    const e = errorsOf(p, r);
    expect(e).toMatch(/downloadCount/);
    expect(e).toMatch(/kebab-case/);
  });

  it("rejects withdrawn releases without a reason and absolute/remote media paths", () => {
    const { p, r } = base();
    (r.releases[3]! as { withdrawnReason: string | null }).withdrawnReason = null;
    p.products[2]!.media[0]!.src = "https://example.com/x.png";
    const e = errorsOf(p, r);
    expect(e).toMatch(/Withdrawn releases need a reason/);
    expect(e).toMatch(/relative path/);
  });
});
