// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256, sha256OfBlob } from "./sha256";

describe("incremental SHA-256", () => {
  it("matches Node's SHA-256 for every padding boundary and for arbitrary slicing", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4096 + 7]) {
      const data = randomBytes(n);
      const want = createHash("sha256").update(data).digest("hex");
      expect(new Sha256().update(data).digestHex()).toBe(want);
      const h = new Sha256();
      for (let i = 0; i < n; ) { const k = 1 + ((i * 7) % 61); h.update(data.subarray(i, i + k)); i += k; }
      expect(h.digestHex()).toBe(want);
    }
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a Blob slice by slice, with progress", async () => {
    const data = randomBytes(3 * 1024 * 1024 + 11);
    const seen: number[] = [];
    const got = await sha256OfBlob(new Blob([data]), { sliceBytes: 1024 * 1024, onProgress: (d) => seen.push(d) });
    expect(got).toBe(createHash("sha256").update(data).digest("hex"));
    expect(seen).toEqual([1048576, 2097152, 3145728, data.length]);
  });
});
