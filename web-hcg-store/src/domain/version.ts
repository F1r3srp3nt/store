/**
 * Semantic Versioning 2.0.0 parsing and precedence.
 * Releases are NEVER ordered alphabetically ("0.10.0" > "0.9.0", "1.0.0" > "1.0.0-rc.1").
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  buildMetadata: string | null;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(input: string): SemVer | null {
  const m = SEMVER.exec(input);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return {
    major: nums[0]!,
    minor: nums[1]!,
    patch: nums[2]!,
    prerelease: m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
    buildMetadata: m[5] ?? null,
  };
}

export const isSemver = (v: string): boolean => parseSemver(v) !== null;

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1; // numeric identifiers have lower precedence
  if (typeof b === "number") return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Returns <0 when a precedes b, >0 when a is newer, 0 when equal precedence. Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Cannot compare non-semver versions "${a}" and "${b}".`);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1; // a release outranks its pre-releases
  if (!y.prerelease.length) return -1;
  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareIdentifiers(p, q);
    if (c !== 0) return c;
  }
  return 0;
}
