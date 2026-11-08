import { describe, expect, it } from "vitest";
import { fixtureCatalogue, realCatalogue } from "../test/fixtures";
import { availability, currentRelease, downloadableArtifacts, findProductBySlug, releaseHistory, releaseRole } from "./model";

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

  it("never offers downloads for withdrawn releases", () => {
    const withdrawn = releaseHistory(c, orbit).find((r) => r.status === "withdrawn")!;
    expect(withdrawn.artifacts.length).toBeGreaterThan(0);
    expect(downloadableArtifacts(withdrawn)).toHaveLength(0);
  });

  it("produces dl=1 Dropbox URLs that keep rlkey", () => {
    const d = downloadableArtifacts(currentRelease(c, orbit)!);
    expect(d).toHaveLength(2);
    for (const x of d) {
      const u = new URL(x.href);
      expect(u.hostname).toBe("www.dropbox.com");
      expect(u.searchParams.get("dl")).toBe("1");
      expect(u.searchParams.get("rlkey")).toMatch(/^FIXTUREONLY/);
      expect(u.searchParams.has("raw")).toBe(false);
    }
  });

  it("derives availability separately from development status", () => {
    expect(availability(c, orbit)).toBe("downloadable");
    expect(availability(c, findProductBySlug(c, "fixture-signal-desk")!)).toBe("release-info-only");
    expect(availability(c, findProductBySlug(c, "fixture-nebula-pad")!)).toBe("none");
  });

  it("reports 'none' for every product in the shipped catalogue", () => {
    const real = realCatalogue();
    for (const p of real.products) expect(availability(real, p)).toBe("none");
  });
});
