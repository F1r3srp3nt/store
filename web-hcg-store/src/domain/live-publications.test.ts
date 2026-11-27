import { describe, expect, it } from "vitest";
import { realCatalogue as shipped } from "../test/fixtures";
import type { Catalogue } from "./catalogue";

/** The shipped catalogue without HCG Mail's explicit current release (what the overlay has to work from). */
const realCatalogue = (): Catalogue => {
  const c = shipped();
  return { ...c, products: c.products.map((p) => (p.id === "hcg-mail" ? { ...p, currentReleaseId: null } : p)) };
};
import { applyLivePublications, type LivePublication } from "./live-publications";
import { currentRelease } from "./model";

const pub = (over: Partial<LivePublication> = {}): LivePublication => ({
  releaseId: "rel-0123456789abcdef", editionId: "windows-desktop", version: "1.0.0-beta.2", build: "2", channel: "beta", distribution: "free", publishedAt: Date.UTC(2026, 11, 1),
  releaseNotes: ["Second beta."], knownLimitations: ["Not code-signed."],
  files: [{ id: "art-0123456789abcdef", fileName: "HCGMail.exe", platform: "windows", format: "exe", architectures: ["x64"], minimumOs: "Windows 10", sizeBytes: 1000, sha256: "a".repeat(64), signing: "unsigned" }],
  ...over,
});

describe("live publications overlay", () => {
  it("adds a release HCG Store published and makes it current when it is the product's only current release", () => {
    const c = applyLivePublications(realCatalogue(), { format: "hcg.store.published/1", products: { "hcg-mail": [pub()] } });
    const mail = c.products.find((p) => p.id === "hcg-mail")!;
    const r = currentRelease(c, mail)!;
    expect(r).toMatchObject({ id: "rel-0123456789abcdef", version: "1.0.0-beta.2", status: "approved", releaseDate: "2026-12-01" });
    expect(r.artifacts[0]).toMatchObject({ fileName: "HCGMail.exe", sizeBytes: 1000, signing: { status: "unsigned" }, editionId: "windows-desktop" });
  });

  it("uses the release already in the catalogue when HCG Store names it", () => {
    const c = applyLivePublications(realCatalogue(), { format: "hcg.store.published/1", products: { "hcg-mail": [pub({ releaseId: "rel-bc6c2096b73a977f", version: "1.0.0-beta.1" })] } });
    expect(currentRelease(c, c.products.find((p) => p.id === "hcg-mail")!)?.id).toBe("rel-bc6c2096b73a977f");
    expect(c.releases.filter((r) => r.id === "rel-bc6c2096b73a977f")).toHaveLength(1);
  });

  it("infers nothing with several current releases, never overrides an explicit choice, and ignores unknown answers", () => {
    const two = applyLivePublications(realCatalogue(), { format: "hcg.store.published/1", products: { "hcg-mail": [pub(), pub({ releaseId: "rel-fedcba9876543210", files: [] })] } });
    expect(two.products.find((p) => p.id === "hcg-mail")!.currentReleaseId).toBeNull();
    const base = realCatalogue();
    const explicit = { ...base, products: base.products.map((p) => (p.id === "hcg-mail" ? { ...p, currentReleaseId: "rel-bc6c2096b73a977f" } : p)) };
    expect(applyLivePublications(explicit, { format: "hcg.store.published/1", products: { "hcg-mail": [pub()] } }).products.find((p) => p.id === "hcg-mail")!.currentReleaseId).toBe("rel-bc6c2096b73a977f");
    expect(applyLivePublications(base, null)).toBe(base);
    expect(applyLivePublications(base, { format: "other" as never, products: {} })).toBe(base);
  });
});
