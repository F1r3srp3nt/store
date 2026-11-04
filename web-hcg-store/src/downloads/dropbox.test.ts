import { describe, expect, it } from "vitest";
import { toDropboxDownloadUrl } from "./dropbox";

const ok = (input: string) => {
  const r = toDropboxDownloadUrl(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r;
};
const code = (input: unknown) => {
  const r = toDropboxDownloadUrl(input);
  return r.ok ? "ok" : r.code;
};

describe("Dropbox shared-link conversion", () => {
  it("sets dl=1 and preserves rlkey and other parameters (scl/fi links)", () => {
    const r = ok("https://www.dropbox.com/scl/fi/abc123XYZ_-/HCG-Mail-0.1.0-win-x64.zip?rlkey=k3y9&st=s7t&e=2&dl=0");
    const u = new URL(r.url);
    expect(u.searchParams.get("dl")).toBe("1");
    expect(u.searchParams.get("rlkey")).toBe("k3y9");
    expect(u.searchParams.get("st")).toBe("s7t");
    expect(u.searchParams.get("e")).toBe("2");
    expect(u.pathname).toBe("/scl/fi/abc123XYZ_-/HCG-Mail-0.1.0-win-x64.zip");
    expect(r.fileName).toBe("HCG-Mail-0.1.0-win-x64.zip");
    expect(r.linkType).toBe("scl-file");
  });

  it("adds dl=1 when missing, replaces duplicates, removes raw=1 and drops fragments", () => {
    expect(new URL(ok("https://www.dropbox.com/scl/fi/a1/f.zip?rlkey=r").url).searchParams.getAll("dl")).toEqual(["1"]);
    const dup = new URL(ok("https://www.dropbox.com/scl/fi/a1/f.zip?dl=0&rlkey=r&dl=0").url);
    expect(dup.searchParams.getAll("dl")).toEqual(["1"]);
    const raw = ok("https://www.dropbox.com/scl/fi/a1/f.dmg?rlkey=r&raw=1#frag");
    expect(new URL(raw.url).searchParams.has("raw")).toBe(false);
    expect(raw.url).not.toContain("#");
  });

  it("accepts legacy /s/ links and the bare dropbox.com host", () => {
    expect(ok("https://www.dropbox.com/s/abc123/app.dmg?dl=0").linkType).toBe("legacy-file");
    expect(ok("https://dropbox.com/scl/fi/abc/app.zip?rlkey=x").url).toMatch(/^https:\/\/dropbox\.com\//);
  });

  it("decodes encoded file names", () => {
    expect(ok("https://www.dropbox.com/scl/fi/abc/HCG%20Mail%200.1.0.zip?rlkey=x").fileName).toBe("HCG Mail 0.1.0.zip");
  });

  it.each([
    ["", "empty"],
    [null, "empty"],
    ["not a url", "invalid-characters"],
    ["dropbox.com/scl/fi/a/b.zip?rlkey=x", "malformed"],
    ["//www.dropbox.com/scl/fi/a/b.zip?rlkey=x", "malformed"],
    ["http://www.dropbox.com/scl/fi/a/b.zip?rlkey=x", "unsupported-protocol"],
    ["ftp://www.dropbox.com/scl/fi/a/b.zip?rlkey=x", "unsupported-protocol"],
    ["javascript:alert(1)//www.dropbox.com/scl/fi/a/b.zip", "unsupported-protocol"],
    ["data:text/html,https://www.dropbox.com/scl/fi/a/b.zip", "unsupported-protocol"],
    ["https://user:pass@www.dropbox.com/scl/fi/a/b.zip?rlkey=x", "credentials"],
    ["https://www.dropbox.com@evil.example/scl/fi/a/b.zip?rlkey=x", "credentials"],
    ["https://www.dropbox.com:8443/scl/fi/a/b.zip?rlkey=x", "port"],
    ["https://www.dropbox.com.evil.example/scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://evil-dropbox.com/scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://dropbox.co/scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://www.dropb0x.com/scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://www.dropbox.com./scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://www.drоpbox.com/scl/fi/a/b.zip?rlkey=x", "unsupported-host"], // Cyrillic "о" (IDN homograph)
    ["https://dl.dropboxusercontent.com/scl/fi/a/b.zip?rlkey=x", "unsupported-host"],
    ["https://evil.example/?u=https://www.dropbox.com/scl/fi/a/b.zip", "unsupported-host"],
    ["https://evil.example\\@www.dropbox.com/scl/fi/a/b.zip?rlkey=x", "invalid-characters"],
    ["https://www.dropbox.com/scl/fi/a/b.zip?rlkey=x\n", "ok"], // trailing whitespace is trimmed
    ["https://www.dropbox.com/scl/fi/a/b c.zip?rlkey=x", "invalid-characters"],
    ["https://www.dropbox.com/scl/fo/abc/folder?rlkey=x", "unsupported-link-type"],
    ["https://www.dropbox.com/sh/abc/folder?dl=0", "unsupported-link-type"],
    ["https://www.dropbox.com/home/private.zip", "unsupported-link-type"],
    ["https://www.dropbox.com/scl/fi/abc/extra/b.zip?rlkey=x", "unsupported-link-type"],
    ["https://www.dropbox.com/scl/fi/abc/b.zip", "missing-rlkey"],
    ["https://www.dropbox.com/scl/fi/abc/b.zip?rlkey=", "missing-rlkey"],
    [`https://www.dropbox.com/scl/fi/abc/b.zip?rlkey=${"x".repeat(2100)}`, "too-long"],
  ])("rejects %j as %s", (input, expected) => {
    expect(code(input)).toBe(expected);
  });
});
