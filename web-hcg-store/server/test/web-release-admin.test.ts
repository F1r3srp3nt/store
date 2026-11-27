// @vitest-environment node
/**
 * Complete website release administration (TEST Store, isolated TEST releases): drafts, metadata edits, uploads,
 * Release Passport and validation evidence, submission, the Release Readiness Inspector, the Founder's own audited
 * exception (only when HCG confirms the Founder policy centrally), approval, rejection and requests for changes,
 * publication, per-platform current versions, supersede and rollback, history and audit. The same management API the
 * website, HCG Executable Maker and HCG Store Manager use: one release service, one audit chain.
 */
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { startHarness, type Client, type Harness } from "./harness";

const MAKER = "99999999-8888-4777-8666-555555555555";
const FOUNDER = { sub: "user-founder", email: "founder@example.test", name: "Founder" };
const STAFF = { sub: "user-staff", email: "staff@example.test", name: "Staff publisher" }; // all three permissions, not the Founder
const REVIEWER = { sub: "user-reviewer", email: "reviewer@example.test", name: "Reviewer" };
const CUSTOMER = { sub: "user-customer", email: "customer@example.test", name: "Customer" };
const PRODUCT = "fixture-quasar-shell";
const ALL = ["store.publish", "store.release.approve", "store.release.publish"];

let h: Harness;
let ledger: TestLedgerAuthority;
beforeEach(async () => {
  h = await startHarness({
    env: {
      HCG_STORE_PUBLISHING: "enabled", HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER, HCG_STORE_UPLOAD_CHUNK_MB: "1",
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish", HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve", HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
    },
  });
  h.idp.otherClients.add(MAKER);
  ledger = h.authority as TestLedgerAuthority;
  for (const f of ALL) {
    ledger.grant(FOUNDER.sub, "hcg.store", featureEdition(f), "test", null);
    ledger.grant(STAFF.sub, "hcg.store", featureEdition(f), "test", null);
  }
  for (const f of ALL.slice(1)) ledger.grant(REVIEWER.sub, "hcg.store", featureEdition(f), "test", null);
  // HCG's central Founder policy (founder_owner_all_products) for the Founder only.
  ledger.setFounderPolicy(FOUNDER.sub, true);
});
afterEach(async () => h.stop());

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function exe(): Buffer {
  const b = Buffer.concat([Buffer.alloc(512), randomBytes(200_000)]);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(128, 60); b.write("PE\0\0", 128, "latin1"); b.writeUInt16LE(0x8664, 132); b.writeUInt16LE(0x20b, 128 + 24);
  return b;
}
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const macApp = (signed: boolean) => zip([
  { name: "Quasar.app/Contents/Info.plist", data: Buffer.from("<plist/>") },
  { name: "Quasar.app/Contents/MacOS/Quasar", data: randomBytes(2048) },
  ...(signed ? [{ name: "Quasar.app/Contents/_CodeSignature/CodeResources", data: Buffer.from("<plist/>") }] : []),
]);
const WIN = { fileName: "QuasarSetup-x64.exe", platform: "windows", format: "exe", architectures: ["x64"], buildProvider: "manual-upload" };
const MAC = (notarized: boolean) => ({ fileName: "Quasar-macOS.zip", platform: "macos", format: "zip", architectures: ["arm64"], buildProvider: "manual-upload",
  signing: notarized ? { status: "notarized", evidence: "TEST: codesign Developer ID; notarytool Accepted; stapled" } : { status: "unsigned", evidence: null } });

type J = Record<string, any>;
async function call(c: Client, method: string, path: string, body?: unknown): Promise<{ status: number; body: J }> {
  const r = await c.request(path, { method, ...(body !== undefined ? { json: body } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as J };
}
async function upload(c: Client, releaseId: string, file: Buffer, decl: J) {
  const d = await call(c, "POST", `/api/v1/publishing/releases/${releaseId}/artifacts`, { sizeBytes: file.length, sha256: sha(file), ...decl });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const r = await fetch(d.body.uploadUrl, { method: "PUT", headers: { "content-range": `bytes 0-${file.length - 1}/${file.length}` }, body: file });
  expect(r.status).toBe(200);
  const done = await call(c, "POST", `/api/v1/publishing/artifacts/${d.body.artifact.id}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.artifact as J;
}
async function draft(c: Client, version: string, build = "1", extra: J = {}) {
  const r = await call(c, "POST", "/api/v1/publishing/releases", {
    productId: PRODUCT, editionId: "standard", version, build, channel: "stable", distribution: "paid", eligibility: "public", releaseNotes: [`TEST ${version}.`], ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const readiness = async (c: Client, id: string) => (await call(c, "GET", `/api/v1/publishing/releases/${id}/readiness`)).body;
const exceptionFor = async (c: Client, id: string, version: string, reason = "TEST: founder-operated release") => {
  const rd = await readiness(c, id);
  return call(c, "POST", `/api/v1/publishing/releases/${id}/founder-exception`, { confirm: version, reason, filesDigest: rd.governance.filesDigest });
};

describe("website release administration (TEST Store)", () => {
  it("the Founder creates, edits, uploads, submits, records an audited exception, approves and publishes, all on the website", async () => {
    const founder = await h.signIn(FOUNDER);
    const id = await draft(founder, "3.0.0", "1", { releaseNotes: [] });
    // Readiness explains what is missing, with a resolution, instead of a missing button.
    let rd = await readiness(founder, id);
    expect(rd.steps.submit.allowed).toBe(false);
    expect(rd.steps.submit.reasons.join(" ")).toMatch(/No verified file yet/);
    expect(rd.steps.submit.reasons.join(" ")).toMatch(/Release notes are empty/);
    expect(rd.steps.approve.reasons.join(" ")).toMatch(/draft: submit it for review first/);
    // Edit metadata (no file is touched).
    const edited = await call(founder, "PATCH", `/api/v1/publishing/releases/${id}`, { releaseNotes: ["TEST 3.0.0: first website-administered release."], knownLimitations: ["TEST only."] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.releaseNotes).toEqual(["TEST 3.0.0: first website-administered release."]);
    const win = exe();
    const art = await upload(founder, id, win, WIN);
    expect(art).toMatchObject({ status: "verified", sha256: sha(win) });
    expect((await call(founder, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);

    // Own release: approval is blocked by separation of duties, and the resolution is the founder exception.
    rd = await readiness(founder, id);
    expect(rd.governance).toMatchObject({ sameParty: true, createdBy: "you", submittedBy: "you", exception: null, founderConfirmedByHcg: true, independentReview: false });
    expect(rd.steps.approve.allowed).toBe(false);
    expect(rd.steps.approve.reasons.join(" ")).toMatch(/founder-operated exception/);
    expect(rd.steps.approve.resolution).toEqual({ action: "founder-exception", label: "Record founder exception" });
    expect(rd.steps.founderException.allowed).toBe(true);
    expect((await call(founder, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "3.0.0" })).body.error.code).toBe("separation_of_duties");

    // The exception needs the typed version and the digest of the files the Founder reviewed.
    expect((await call(founder, "POST", `/api/v1/publishing/releases/${id}/founder-exception`, { confirm: "3.0.0", reason: "TEST", filesDigest: "0".repeat(64) })).body.error.code).toBe("files_changed");
    expect((await call(founder, "POST", `/api/v1/publishing/releases/${id}/founder-exception`, { confirm: "2.9.9", reason: "TEST", filesDigest: rd.governance.filesDigest })).body.error.code).toBe("confirmation_required");
    const ex = await exceptionFor(founder, id, "3.0.0", "TEST: the Founder releases their own build");
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body.exception).toMatchObject({ releaseId: id, kind: "founder-operated", artifactDigest: rd.governance.filesDigest, reason: "TEST: the Founder releases their own build", revokedAt: null });
    expect(ex.body.exception.authorisedBy).toMatch(/^The Founder.*Founder policy confirmed by HCG at \d{4}-/);
    // Recorded once: a second one is refused.
    expect((await exceptionFor(founder, id, "3.0.0")).status).toBe(409);

    rd = await readiness(founder, id);
    expect(rd.steps.approve.allowed).toBe(true);
    const ap = await call(founder, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "3.0.0", current: true });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect((await readiness(founder, id)).steps.publish.allowed).toBe(true);
    const pub = await call(founder, "POST", `/api/v1/publishing/releases/${id}/publish`, { confirm: "3.0.0" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);

    // The audit names the Founder (not an operator), the release, every file's SHA-256, the reason and the time, and
    // marks approval and publication as not independently reviewed. No independent reviewer is invented.
    const full = (await call(founder, "GET", `/api/v1/publishing/releases/${id}`)).body;
    const granted = full.audit.find((a: J) => a.action === "release.exception-granted");
    expect(granted.actor).toBe(FOUNDER.sub);
    expect(granted.detail).toMatchObject({ selfRecorded: true, via: "web", centralBasis: "founder_owner_all_products", independentReview: false, files: [{ fileName: "QuasarSetup-x64.exe", sha256: sha(win) }] });
    expect(typeof granted.at).toBe("number");
    for (const action of ["release.approved", "release.published"]) {
      const a = full.audit.find((x: J) => x.action === action);
      expect(a.actor).toBe(FOUNDER.sub);
      expect(a.detail.governance).toMatchObject({ exceptionId: ex.body.exception.id, independentReview: false });
    }
    expect(full.audit.map((a: J) => a.action)).toEqual(expect.arrayContaining(["release.draft-created", "release.updated", "artifact.declared", "artifact.verified", "release.submitted", "release.exception-granted", "release.approved", "release.published"]));
  });

  it("refuses the exception to anyone HCG does not confirm as the Founder, from a desktop app, when not needed, and never for unsigned public macOS files", async () => {
    // Staff with all three permissions, but not the Founder: own release → no exception, approval blocked.
    const staff = await h.signIn(STAFF);
    const id = await draft(staff, "4.0.0");
    await upload(staff, id, exe(), WIN);
    expect((await call(staff, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
    let rd = await readiness(staff, id);
    expect(rd.governance.founderConfirmedByHcg).toBe(false);
    expect(rd.steps.founderException.allowed).toBe(false);
    expect(rd.steps.founderException.reasons.join(" ")).toMatch(/does not confirm the Founder policy/);
    expect((await exceptionFor(staff, id, "4.0.0")).body.error.code).toBe("founder_exception_not_allowed");
    // The normal path still works: another person approves and publishes.
    const reviewer = await h.signIn(REVIEWER);
    rd = await readiness(reviewer, id);
    expect(rd.steps.approve.allowed).toBe(true);
    expect(rd.steps.founderException.reasons.join(" ")).toMatch(/Not needed/);
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "4.0.0" })).status).toBe(200);

    // A desktop token (Executable Maker) cannot record an exception or approve.
    const founder = await h.signIn(FOUNDER);
    const fid = await draft(founder, "4.1.0");
    await upload(founder, fid, exe(), WIN);
    const token = await h.idp.accessToken(FOUNDER, MAKER);
    const desk = await fetch(`${h.origin}/api/v1/publishing/releases/${fid}/founder-exception`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ confirm: "4.1.0", reason: "x", filesDigest: "0".repeat(64) }) });
    expect(desk.status).toBe(403);

    // Unsigned macOS for the public: the exception is refused and approval is refused, with the reason.
    const mid = await draft(founder, "4.2.0");
    await upload(founder, mid, macApp(false), MAC(false));
    expect((await call(founder, "POST", `/api/v1/publishing/releases/${mid}/submit`)).status).toBe(200);
    rd = await readiness(founder, mid);
    expect(rd.signing.publicBlockers.join(" ")).toMatch(/must be Developer ID signed and notarized/);
    expect(rd.steps.founderException.allowed).toBe(false);
    expect(rd.steps.founderException.reasons.join(" ")).toMatch(/never changes them/);
    expect((await exceptionFor(founder, mid, "4.2.0")).status).toBe(409);
    const reviewerTry = await call(reviewer, "POST", `/api/v1/publishing/releases/${mid}/approve`, { eligibility: "public", confirm: "4.2.0" });
    expect(reviewerTry.body.error.code).toBe("not_installable");
    // Internal testing remains possible.
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${mid}/approve`, { eligibility: "internal-testing", confirm: "4.2.0" })).status).toBe(200);

    // Ordinary customers see nothing and change nothing.
    const customer = await h.signIn(CUSTOMER);
    expect((await call(customer, "GET", `/api/v1/publishing/releases/${id}/readiness`)).status).toBe(403);
    for (const a of ["approve", "publish", "reject", "request-changes", "founder-exception"]) {
      expect((await call(customer, "POST", `/api/v1/publishing/releases/${fid}/${a}`, { confirm: "4.1.0", reason: "x", eligibility: "public", filesDigest: "0".repeat(64) })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await call(customer, "PATCH", `/api/v1/publishing/releases/${fid}`, { releaseNotes: ["hijack"] })).status).toBe(403);
  });

  it("reviewers request corrections or reject with a recorded reason; edits after approval reset it", async () => {
    const staff = await h.signIn(STAFF);
    const reviewer = await h.signIn(REVIEWER);
    const id = await draft(staff, "5.0.0");
    await upload(staff, id, exe(), WIN);
    expect((await call(staff, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
    const rc = await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/request-changes`, { reason: "TEST: add the limitations." });
    expect(rc.status).toBe(200);
    expect(rc.body.status).toBe("draft");
    expect((await readiness(staff, id)).reviewNotes[0]).toMatchObject({ action: "release.changes-requested", reason: "TEST: add the limitations." });
    expect((await call(staff, "PATCH", `/api/v1/publishing/releases/${id}`, { knownLimitations: ["TEST: none known."] })).status).toBe(200);
    expect((await call(staff, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "5.0.0" })).status).toBe(200);
    // Editing an approved release sends it back to draft: the approval was for the record as it was.
    const after = await call(staff, "PATCH", `/api/v1/publishing/releases/${id}`, { releaseNotes: ["TEST 5.0.0, changed after approval."] });
    expect(after.body.status).toBe("draft");
    expect((await call(staff, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
    const rj = await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/reject`, { reason: "TEST: wrong build." });
    expect(rj.status).toBe(200);
    expect(rj.body).toMatchObject({ status: "withdrawn", withdrawnReason: "Rejected: TEST: wrong build." });
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: "5.0.0" })).status).toBe(409);
    expect((await call(staff, "PATCH", `/api/v1/publishing/releases/${id}`, { releaseNotes: ["x"] })).body.error.code).toBe("release_locked");
    const actions = (await call(reviewer, "GET", `/api/v1/publishing/releases/${id}`)).body.audit.map((a: J) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["release.changes-requested", "release.updated", "release.approval-invalidated", "release.rejected"]));
  });

  it("current versions are independent per platform; supersede and rollback switch only their own platform", async () => {
    const staff = await h.signIn(STAFF);
    const reviewer = await h.signIn(REVIEWER);
    const ship = async (version: string, files: { file: Buffer; decl: J }[], publishBody: J = {}) => {
      const id = await draft(staff, version);
      for (const f of files) await upload(staff, id, f.file, f.decl);
      expect((await call(staff, "POST", `/api/v1/publishing/releases/${id}/submit`)).status).toBe(200);
      expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/approve`, { eligibility: "public", confirm: version })).status).toBe(200);
      const p = await call(reviewer, "POST", `/api/v1/publishing/releases/${id}/publish`, { confirm: version, ...publishBody });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      return id;
    };
    const v1 = await ship("6.0.0", [{ file: exe(), decl: WIN }, { file: macApp(true), decl: MAC(true) }]);
    const v2 = await ship("6.1.0", [{ file: exe(), decl: WIN }], { supersedePrevious: true });
    const targets = async (id: string) => (await call(reviewer, "GET", `/api/v1/publishing/releases/${id}`)).body.targets.map((t: J) => `${t.platform}:${t.current}`).sort();
    expect(await targets(v1)).toEqual(["macos:true", "windows:false"]);
    expect(await targets(v2)).toEqual(["windows:true"]);
    // Rollback (restore) of Windows to 6.0.0 leaves macOS as it was.
    const rb = await call(reviewer, "POST", `/api/v1/publishing/releases/${v1}/restore`, { confirm: "6.0.0", reason: "TEST rollback" });
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(await targets(v1)).toEqual(["macos:true", "windows:true"]);
    expect(await targets(v2)).toEqual(["windows:false"]);
    // Withdrawal ends delivery of a release and is recorded.
    expect((await call(reviewer, "POST", `/api/v1/publishing/releases/${v2}/withdraw`, { reason: "TEST withdrawn" })).status).toBe(200);
  });
});
