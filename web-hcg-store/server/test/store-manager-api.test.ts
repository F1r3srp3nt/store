// @vitest-environment node
/**
 * The publishing API as HCG Store Manager uses it: capabilities, manual uploads (no invented provenance), duplicate
 * and quota refusals, and attaching an HCG Release Passport that must match the stored bytes exactly. Uses a draft
 * product (Store-internal), so no catalogue product is touched.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Harness } from "./harness";

const CLIENT = "99999999-8888-4777-8666-555555555556"; // TEST client standing in for HCG Store Manager
const PUBLISHER = { sub: "user-publisher", email: "pub@example.test", name: "Publisher" };
const CUSTOMER = { sub: "user-customer", email: "c@example.test", name: "Customer" };
const sha = (b: Buffer, a = "sha256") => createHash(a).update(b).digest("hex");

let h: Harness;
async function start(extra: Record<string, string> = {}) {
  h = await startHarness({ env: {
    HCG_STORE_PUBLISHING: "enabled", HCG_STORE_PUBLISHING_CLIENT_IDS: CLIENT,
    HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish", HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
    HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish", HCG_STORE_UPLOAD_CHUNK_MB: "1", ...extra,
  } });
  h.idp.otherClients.add(CLIENT);
  (h.authority as TestLedgerAuthority).grant(PUBLISHER.sub, "*", featureEdition("store.publish"), "test", null);
}
afterEach(async () => h.stop());

function pe(tag: string): Buffer {
  const b = Buffer.alloc(2048); b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(0x8664, 0x84); b.write(tag, 0x400, "latin1"); return b;
}
async function app(user = PUBLISHER) {
  const token = await h.idp.accessToken(user, CLIENT);
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
}
async function draft(call: Awaited<ReturnType<typeof app>>) {
  await call("POST", "/api/v1/publishing/products", { id: "sm-test-tool", title: "SM Test Tool" });
  const r = await call("POST", "/api/v1/publishing/releases", { productId: "sm-test-tool", version: "1.0.0", build: "1", releaseNotes: ["First."], distribution: "free", eligibility: "private" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
async function put(call: Awaited<ReturnType<typeof app>>, rel: string, file: Buffer, name: string, extra: Record<string, unknown> = {}) {
  const d = await call("POST", `/api/v1/publishing/releases/${rel}/artifacts`, { fileName: name, platform: "windows", format: "exe", sizeBytes: file.length, sha256: sha(file), architectures: ["x64"], signing: { status: "unsigned", evidence: "structure: absent", tool: "HCG Store Manager" }, buildProvider: "manual-upload", ...extra });
  if (d.status !== 201) return { declared: d };
  for (let s = 0; s < file.length; s += d.body.chunkBytes) {
    const e = Math.min(file.length, s + d.body.chunkBytes) - 1;
    await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes ${s}-${e}/${file.length}` }, body: file.subarray(s, e + 1) });
  }
  return { declared: d, completed: await call("POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`) };
}

describe("HCG Store Manager API", () => {
  beforeEach(async () => start());

  it("capabilities: version, limits, formats and storage; only for people HCG lets publish", async () => {
    const c = await (await app())("GET", "/api/v1/publishing/capabilities");
    expect(c).toMatchObject({ status: 200, body: { apiVersion: 1, chunkBytes: 1024 * 1024, approvalAndPublication: "browser-only", storage: { usedBytes: 0, quotaBytes: null } } });
    expect(c.body.formats.windows).toMatchObject({ exe: ".exe", zip: ".zip" });
    expect((await (await app(CUSTOMER))("GET", "/api/v1/publishing/capabilities")).status).toBe(403);
  });

  it("a manual upload claims no build evidence, can be submitted honestly, and shows as such", async () => {
    const call = await app();
    const rel = await draft(call);
    const refused = await put(call, rel, pe("a"), "Tool-Setup.exe", { sourceCommit: "0123abcd" });
    expect(refused.declared).toMatchObject({ status: 400, body: { error: { code: "artifact_refused" } } });
    const ok = await put(call, rel, pe("a"), "Tool-Setup.exe");
    expect(ok.completed!.body.artifact).toMatchObject({ status: "verified", provenance: { buildProvider: "manual-upload", sourceCommit: null } });
    expect((await call("POST", `/api/v1/publishing/releases/${rel}/submit`)).status).toBe(200);
  });

  it("refuses the same bytes twice in a release, and a different file under a verified name needs a new identity", async () => {
    const call = await app();
    const rel = await draft(call);
    await put(call, rel, pe("a"), "Tool-Setup.exe");
    const dup = await put(call, rel, pe("a"), "Tool-Setup-copy.exe");
    expect(dup.declared.status).toBe(400);
    expect(JSON.stringify(dup.declared.body)).toMatch(/same bytes/);
  });

  it("refuses a declared SHA-256 the uploaded bytes do not have (tampered or corrupted)", async () => {
    const call = await app();
    const rel = await draft(call);
    const file = pe("b");
    const d = await call("POST", `/api/v1/publishing/releases/${rel}/artifacts`, { fileName: "T.exe", platform: "windows", format: "exe", sizeBytes: file.length, sha256: sha(pe("other")), buildProvider: "manual-upload" });
    await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
    const done = await call("POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`);
    expect(done.status).not.toBe(200);
    expect(JSON.stringify(done.body)).toMatch(/SHA-256|sha256|checksum/i);
  });

  it("attaches a Release Passport only when it describes the stored bytes exactly, and only in a draft", async () => {
    const call = await app();
    const rel = await draft(call);
    const file = pe("c");
    const { declared } = await put(call, rel, file, "Tool-Setup.exe");
    const id = declared.body.artifact.id as string;
    const passport = { format: "hcg.release-passport", formatVersion: 1, source: { commit: "8bb1a4f078326da6373962cb81a96f88675bc3f4" }, build: { provider: "github-actions", run_id: 42 },
      artifact: { filename: "Tool-Setup.exe", size: file.length, sha256: sha(file), sha512: sha(file, "sha512") } };
    const bad = await call("POST", `/api/v1/publishing/artifacts/${id}/passport`, { ...passport, artifact: { ...passport.artifact, sha512: "0".repeat(128) } });
    expect(bad).toMatchObject({ status: 422, body: { error: { code: "passport_mismatch" } } });
    const good = await call("POST", `/api/v1/publishing/artifacts/${id}/passport`, passport);
    expect(good.body.artifact.provenance.passport).toMatchObject({ commit: "8bb1a4f078326da6373962cb81a96f88675bc3f4", provider: "github-actions", runId: "42" });
    // Still a manual upload: the passport is evidence next to it, not a rewrite of what was declared.
    expect(good.body.artifact.provenance.buildProvider).toBe("manual-upload");
    await call("POST", `/api/v1/publishing/releases/${rel}/submit`);
    expect((await call("POST", `/api/v1/publishing/artifacts/${id}/passport`, passport)).body.error.code).toBe("not_draft");
    expect((await (await app(CUSTOMER))("POST", `/api/v1/publishing/artifacts/${id}/passport`, passport)).status).toBe(403);
  });
});

describe("storage quota", () => {
  beforeEach(async () => start({ HCG_STORE_STORAGE_QUOTA_MB: "1" }));
  it("refuses a declaration that would exceed the quota", async () => {
    const call = await app();
    const rel = await draft(call);
    const big = Buffer.concat([pe("q"), Buffer.alloc(1024 * 1024)]);
    const d = await call("POST", `/api/v1/publishing/releases/${rel}/artifacts`, { fileName: "Big.exe", platform: "windows", format: "exe", sizeBytes: big.length, sha256: sha(big), buildProvider: "manual-upload" });
    expect(d).toMatchObject({ status: 409, body: { error: { code: "quota_exceeded" } } });
  });
});
