import { describe, expect, it } from "vitest";
import { compareSemver, isSemver, parseSemver } from "./version";

describe("semantic version precedence", () => {
  it("parses valid versions and rejects invalid ones", () => {
    expect(parseSemver("1.2.3-beta.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["beta", 1], buildMetadata: "build.5" });
    for (const v of ["1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "latest", ""]) expect(isSemver(v)).toBe(false);
  });

  it("does not sort alphabetically", () => {
    const versions = ["1.9.2", "1.10.0", "1.2.0", "0.10.0", "0.9.0", "2.0.0-beta.1", "1.10.0-rc.1"];
    expect([...versions].sort(compareSemver)).toEqual(["0.9.0", "0.10.0", "1.2.0", "1.9.2", "1.10.0-rc.1", "1.10.0", "2.0.0-beta.1"]);
    expect([...versions].sort()).not.toEqual([...versions].sort(compareSemver)); // proves the trap exists
  });

  it("follows SemVer 2.0.0 pre-release rules", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i < order.length - 1; i++) expect(compareSemver(order[i]!, order[i + 1]!)).toBeLessThan(0);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("1.0.0+1", "1.0.0+2")).toBe(0);
  });
});
