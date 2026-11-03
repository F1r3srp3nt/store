import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "check-bundle-secrets.mjs");
const run = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "hcg-scan-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  try {
    return { code: 0, out: execFileSync("node", [script, dir], { encoding: "utf8", stdio: "pipe", cwd: dir }) };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, out: err.stderr };
  }
};

describe("bundle secret scanner", () => {
  it("passes clean output", () => {
    expect(run({ "a.js": 'const x = "https://www.dropbox.com/scl/fi/a/b.zip?rlkey=x&dl=1";' }).code).toBe(0);
  });
  it.each([
    ["JWT", "const k='eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlc2lnbmF0dXJl'"],
    ["Anthropic key", "x='sk-ant-api03-abcdefghijklmnop'"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["client secret", 'cfg={client_secret:"supersecretvalue"}'],
    ["service role", "SUPABASE_SERVICE_ROLE / service_role"],
  ])("fails on %s", (_label, content) => {
    const r = run({ "index.js": content });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Secret scan FAILED/);
  });
});
