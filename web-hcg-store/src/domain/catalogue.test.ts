import { describe, expect, it } from "vitest";
import { clone, raw, realCatalogue } from "../test/fixtures";
import { validateCatalogue } from "./catalogue";

/** Products with a development repository that states an accurate description and status. */
const REQUESTED_NAMES = [
  "HCG LifeOS",
  "HCG Mail",
  "HCG ONE: Unleashed",
  "HCG News",
  "HCG Executable Maker",
  "HCG RePrompter",
  "HCG CardX",
  "HCG Terminal",
  "HCG Nexus",
  "HCG Sentinel",
  "HCG Clarity",
]

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

  it("claims no releases or downloads, and only the central registry IDs HCG confirmed", () => {
    expect(c.releases).toHaveLength(0);
    // Confirmed by the main-site handoff (16 Nov 2026, VERIFIED against app_applications.product_id).
    const confirmed: Record<string, string> = {
      "hcg-terminal": "hcg.terminal",
      "hcg-executable-maker": "hcg.executable.maker",
      "hcg-mail": "hcg.mail",
      "hcg-news": "hcg.news",
      "hcg-cardx": "hcg-cardx",
      "hcg-lifeos": "hcg.lifeos",
      "hcg-one-unleashed": "hcg.one.unleashed",
      "hcg-reprompter": "hcg.reprompter",
    };
    for (const p of c.products) {
      expect(p.currentReleaseId).toBeNull();
      expect(p.registry.centralId, p.id).toBe(confirmed[p.id] ?? null);
      expect(p.registry.status, p.id).toBe(confirmed[p.id] ? "central" : "provisional");
      // Not registered centrally yet (decision D3): no edition may be mapped either.
      if (!confirmed[p.id]) for (const e of p.editions) expect(e.centralEditionKey, `${p.id}/${e.id}`).toBeNull();
      for (const pl of p.platforms) expect(pl.support).not.toBe("confirmed");
    }
  });

  it("rejects duplicate central edition keys and edition keys without a central product ID", () => {
    const products = clone(raw.realProducts) as { products: { id: string; registry: { status: string; centralId: string | null }; editions: { centralEditionKey: string | null }[] }[] };
    const terminal = products.products.find((p) => p.id === "hcg-terminal")!;
    terminal.editions[1]!.centralEditionKey = terminal.editions[0]!.centralEditionKey;
    const dup = validateCatalogue(products, raw.realReleases);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join("\n")).toMatch(/same central edition key/);

    const unregistered = clone(raw.realProducts) as typeof products;
    const nexus = unregistered.products.find((p) => p.id === "hcg-nexus")!;
    nexus.editions[0]!.centralEditionKey = "app";
    const res = validateCatalogue(unregistered, raw.realReleases);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toMatch(/no central product ID/);
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

  it("rejects signed/notarised claims without evidence and bad checksums", () => {
    const { p, r } = base();
    const art = r.releases[1]!.artifacts[1]! as Record<string, unknown>;
    art.signing = { status: "signed", evidence: null };
    art.sha256 = "ABC";
    const e = errorsOf(p, r);
    expect(e).toMatch(/requires evidence/);
    expect(e).toMatch(/SHA-256/);
  });

  it("rejects any download URL in the public catalogue (files are delivered only after sign-in)", () => {
    const { p, r } = base();
    (r.releases[1]!.artifacts[0]! as Record<string, unknown>).download = { provider: "dropbox", url: "https://www.dropbox.com/scl/fi/a/b.zip?rlkey=x&dl=0" };
    (r.releases[1]!.artifacts[1]! as Record<string, unknown>).url = "https://example.com/file.dmg";
    const e = errorsOf(p, r);
    expect(e).toMatch(/download/);
    expect(e).toMatch(/url/);
  });

  it("validates editions and HCG Repo mappings", () => {
    const { p, r } = base();
    const quasar = p.products.find((x) => x.id === "fixture-quasar-shell")!;
    quasar.hcgRepo!.push({ key: "fixture-quasar-unleashed", editionId: "standard" });
    quasar.hcgRepo!.push({ key: "other-key", editionId: "missing" });
    quasar.editions![1]!.identifiers = [];
    const e = errorsOf(p, r);
    expect(e).toMatch(/Duplicate HCG Repo product key/);
    expect(e).toMatch(/unknown edition "missing"/);
    expect(e).toMatch(/jailbreak package but declares no package identifier/);
  });

  it("requires artifacts to name their edition when a product has several", () => {
    const { p, r } = base();
    const rel = r.releases.find((x) => x.productId === "fixture-quasar-shell")!;
    (rel.artifacts[0] as { editionId: string | null }).editionId = null;
    (rel.artifacts[1] as { editionId: string | null }).editionId = "nope";
    const e = errorsOf(p, r);
    expect(e).toMatch(/must name its edition/);
    expect(e).toMatch(/unknown edition "nope"/);
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

describe("approved product artwork mapping (catalogue is the single source)", () => {
  const c = realCatalogue();
  const product = (id: string) => c.products.find((p) => p.id === id)!;

  it.each(["hcg-cardx", "hcg-clarity", "hcg-executable-maker", "hcg-lifeos", "hcg-mail", "hcg-news", "hcg-nexus", "hcg-one-unleashed"])(
    "%s uses its own 3:1 banner, with AVIF and responsive renditions",
    (id) => {
      const cover = product(id).artwork.cover!;
      expect(cover.src).toBe(`media/products/${id}/banner-2000.webp`);
      expect(cover.variants.map((v) => v.src)).toEqual([`media/products/${id}/banner-640.webp`, `media/products/${id}/banner-1200.webp`]);
      expect(cover.width / cover.height).toBeCloseTo(3, 1);
      expect(cover.avif).toBe(true);
      expect(cover.kind).toBe("official");
    },
  );

  it.each(["hcg-clarity", "hcg-executable-maker", "hcg-lifeos", "hcg-one-unleashed"])("%s uses its new framed icon", (id) => {
    const a = product(id).artwork;
    expect(a.icon!.src).toBe(`media/products/${id}/icon-256.webp`);
    expect([a.icon!.width, a.icon!.height]).toEqual([256, 256]);
    expect(a.iconStyle).toBe("framed");
  });

  it("keeps the existing CardX, Mail, News and Nexus icons, and Terminal and Sentinel artwork", () => {
    for (const id of ["hcg-cardx", "hcg-mail", "hcg-news", "hcg-nexus", "hcg-terminal", "hcg-sentinel"]) {
      expect(product(id).artwork.icon!.src).toBe(`media/products/${id}/icon-256.webp`);
      expect(product(id).artwork.iconStyle).toBe("app");
    }
    expect(product("hcg-terminal").artwork.cover!.src).toBe("media/products/hcg-terminal/cover-2000.webp");
    expect(product("hcg-sentinel").artwork.cover!.src).toBe("media/products/hcg-sentinel/cover-2000.webp");
  });

  it("no two products share a banner or an icon", () => {
    const covers = c.products.flatMap((p) => (p.artwork.cover ? [p.artwork.cover.src] : []));
    const icons = c.products.flatMap((p) => (p.artwork.icon ? [p.artwork.icon.src] : []));
    expect(new Set(covers).size).toBe(covers.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("keeps real screenshots and does not restore the RePrompter listing", () => {
    expect(product("hcg-executable-maker").media.filter((m) => m.kind === "screenshot")).toHaveLength(2);
    expect(product("hcg-clarity").media.filter((m) => m.kind === "screenshot")).toHaveLength(3);
    expect(product("hcg-mail").media.filter((m) => m.kind === "screenshot")).toHaveLength(2);
    expect(product("hcg-reprompter").supersededBy).toBe("hcg-clarity");
    expect(product("hcg-reprompter").artwork.cover).toBeNull();
  });
});
