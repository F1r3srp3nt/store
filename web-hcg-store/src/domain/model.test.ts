import { describe, expect, it } from "vitest";
import { fixtureCatalogue, realCatalogue } from "../test/fixtures";
import { availability, currentRelease, findProductBySlug, hcgRepoLinks, releaseHistory, releaseRole } from "./model";

describe("release model", () => {
  const c = fixtureCatalogue();
  const orbit = findProductBySlug(c, "fixture-orbit-notes")!;

  it("uses the explicitly designated current release, not the highest version", () => {
    expect(currentRelease(c, orbit)?.version).toBe("1.10.0");
    // 2.0.0-beta.1 is newer and approved, but not designated current.
    expect(releaseHistory(c, orbit)[0]!.version).toBe("2.0.0-beta.1");
  });

  it("orders history by semantic version, not alphabetically", () => {
    expect(releaseHistory(c, orbit).map((r) => r.version)).toEqual(["2.0.0-beta.1", "1.10.1-beta.1", "1.10.0", "1.9.2", "1.2.0"]);
  });

  it("distinguishes current, previous, withdrawn and approved-not-current releases", () => {
    const roles = Object.fromEntries(releaseHistory(c, orbit).map((r) => [r.version, releaseRole(c, orbit, r)]));
    expect(roles).toEqual({
      "2.0.0-beta.1": "approved-not-current",
      "1.10.1-beta.1": "withdrawn",
      "1.10.0": "current",
      "1.9.2": "previous",
      "1.2.0": "previous",
    });
  });

  it("never contains download links: files are delivered only by the server", () => {
    for (const r of releaseHistory(c, orbit)) for (const a of r.artifacts) expect(a).not.toHaveProperty("download");
  });

  it("derives availability separately from development status", () => {
    expect(availability(c, orbit)).toBe("released");
    expect(availability(c, findProductBySlug(c, "fixture-signal-desk")!)).toBe("released");
    expect(availability(c, findProductBySlug(c, "fixture-nebula-pad")!)).toBe("coming-soon");
  });

  it("reports 'released' only for HCG Mail (its published, explicitly current release) and 'coming-soon' for the rest", () => {
    const real = realCatalogue();
    for (const p of real.products) expect(availability(real, p), p.id).toBe(p.id === "hcg-mail" ? "released" : "coming-soon");
  });

  it("maps editions to their HCG Repo product pages explicitly", () => {
    const real = realCatalogue();
    const repo = (slug: string, edition?: string | null) => hcgRepoLinks(findProductBySlug(real, slug)!, edition).map((l) => l.key);
    expect(repo("hcg-terminal", "unleashed")).toEqual(["hcg-terminal-unleashed"]);
    expect(repo("hcg-terminal", "standard")).toEqual([]);
    expect(repo("hcg-nexus", "jailbreak")).toEqual(["hcg-nexus"]);
    expect(repo("hcg-sentinel")).toEqual(["hcg-sentinel"]);
    expect(repo("hcg-executable-maker")).toEqual([]);
  });
});
