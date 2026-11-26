/**
 * TEST ONLY. Rehearses a release import end to end against the real catalogue, with the production settings proposed
 * for a free public testing release, and writes the publication preview. Never touches production.
 *
 *   npx tsx server/test/release-rehearsal.ts import --request <request.json> --dir <import folder> --work <dir>
 *       imports, approves and publishes (as TEST identities), opens a 30-day window, checks every gate, downloads
 *       every file as an ordinary tester and compares SHA-256, exports the release record and generates the catalogue
 *       entry into <work>/catalogue (a copy of catalogue/ with releases.json and currentReleaseId updated).
 *   npx tsx server/test/release-rehearsal.ts serve --work <dir> --static <dist>
 *       serves that catalogue and the built site with the same database, for screenshots; prints {origin, issuer}.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createStoreApp } from "../src/app";
import { parseStoreConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { featureEdition, TestLedgerAuthority } from "../src/entitlements";
import { listWindows, openWindow, terminateWindow } from "../src/free-windows";
import { HcgConnectClient } from "../src/hcg-connect";
import { loadRegistry } from "../src/registry";
import { exportReleaseRecords } from "../src/release-records";
import { syncReleases } from "../src/release-sync";
import type { Release } from "../../src/domain/schema";
import { Client } from "./harness";
import { MockHcgConnect } from "./mock-hcg-connect";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const mode = process.argv[2];
const work = resolve(arg("--work") ?? "rehearsal");
const root = resolve(import.meta.dirname, "..", "..");
const FOUNDER = { sub: "test-founder", email: "founder@example.test", name: "Founder (TEST identity)" };
const TESTER = { sub: "test-tester", email: "tester@example.test", name: "Ordinary tester (TEST identity)" };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const step = (msg: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}${detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) process.exitCode = 1;
};

async function startStore(catalogueDir: string, staticDir: string) {
  const idp = new MockHcgConnect();
  await idp.start();
  const server = createServer();
  const port = Number(arg("--port") ?? 0);
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync(join(work, "data"), { recursive: true });
  mkdirSync(join(work, "private"), { recursive: true });
  writeFileSync(join(work, "offers.json"), JSON.stringify({ offers: [] }));
  writeFileSync(join(work, "artifacts.json"), JSON.stringify({ artifacts: [] }));
  const cfg = parseStoreConfig({
    HCG_STORE_MODE: "test",
    HCG_STORE_PUBLIC_ORIGIN: origin,
    HCG_CONNECT_ISSUER: idp.issuer,
    HCG_CONNECT_AUTHORIZATION_ENDPOINT: `${idp.issuer}/oauth/authorize`,
    HCG_CONNECT_TOKEN_ENDPOINT: `${idp.issuer}/oauth/token`,
    HCG_CONNECT_JWKS_URI: `${idp.issuer}/.well-known/jwks.json`,
    HCG_CONNECT_CLIENT_ID: idp.clientId,
    HCG_CONNECT_REDIRECT_URI: `${origin}/auth/callback`,
    HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger",
    // The production settings proposed for this release:
    HCG_STORE_PAYMENT_PROVIDER: "none",
    HCG_STORE_PROTECTED_DOWNLOADS: "free-testing-only",
    HCG_STORE_PUBLISHING: "enabled",
    HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
    HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
    HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
    HCG_STORE_ARTIFACT_STORAGE_DIR: join(work, "private"),
    HCG_STORE_DATA_DIR: join(work, "data"),
    HCG_STORE_STATIC_DIR: staticDir,
    HCG_CATALOGUE_DIR: catalogueDir,
    HCG_STORE_OFFERS_FILE: join(work, "offers.json"),
    HCG_STORE_ARTIFACTS_FILE: join(work, "artifacts.json"),
    HCG_STORE_UPLOAD_MAX_MB: "2048",
  });
  const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
  const db = openDatabase(cfg.dataDir);
  const authority = new TestLedgerAuthority(db, () => Date.now());
  const app = createStoreApp({ cfg, db, registry, connect: new HcgConnectClient(cfg.hcgConnect!, fetch, () => Date.now()), authority, now: () => Date.now() });
  server.on("request", (req, res) => void app.handle(req, res));
  const signIn = async (user: typeof FOUNDER) => {
    const c = new Client(origin);
    idp.nextUser = user;
    const start = await c.get("/auth/login?return_to=/");
    const authz = await fetch(start.headers.get("location")!, { redirect: "manual" });
    await c.get(authz.headers.get("location")!.replace(origin, ""));
    return c;
  };
  return { idp, server, origin, cfg, db, authority, app, signIn };
}

if (mode === "import") {
  const request = JSON.parse(readFileSync(arg("--request")!, "utf8"));
  const dir = resolve(arg("--dir")!);
  const s = await startStore(join(root, "catalogue"), "");
  // HCG's central grants, stood in for by the TEST ledger: the founder may approve and, separately, publish.
  s.authority.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.approve"), "hcg-erp (TEST)", null);
  s.authority.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.publish"), "hcg-erp (TEST)", null);

  const draft = JSON.parse(readFileSync(join(dir, "draft", "store-release-draft.json"), "utf8"));
  const passports: Record<string, unknown> = {};
  for (const f of readdirSync(join(dir, "draft", "passports"))) {
    const p = JSON.parse(readFileSync(join(dir, "draft", "passports", f), "utf8"));
    passports[p.artifact.filename] = p;
  }
  const r = await s.app.publishing.importRelease({
    draft, filesDir: join(dir, "files"), passports: passports as never,
    source: { repository: request.source.repository, commit: request.source.commit, runId: request.source.runId },
    requestedEligibility: request.requestedEligibility, knownLimitations: request.knownLimitations,
    authorisedBy: "founder (rehearsal)", performedBy: "release-import workflow (rehearsal)",
  });
  step("import: submitted private draft, creator is the CI build", r.status === "submitted" && r.approvedEligibility === null && r.createdBy.startsWith("import:"), { id: r.id, createdBy: r.createdBy });
  for (const a of r.artifacts) step(`import: ${a.fileName} verified, unchanged`, a.status === "verified" && a.sha256 === draft.artifacts.find((x: { fileName: string }) => x.fileName === a.fileName).sha256, a.sha256);

  const tester = await s.signIn(TESTER);
  const access = async (c: Client) => ((await (await c.get(`/api/v1/products/${draft.release.productId}/access`)).json()) as { editions: { editionId: string; state: string; artifacts: { id: string; fileName: string }[]; freeTesting: unknown; offers: unknown[] }[] }).editions.find((e) => e.editionId === draft.release.editionId)!;
  step("before approval: nothing delivered to a tester", (await access(tester)).artifacts.length === 0);
  step("an ordinary account cannot approve", (await tester.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: draft.release.version })).status === 403);

  const founder = await s.signIn(FOUNDER);
  const approved = await founder.post(`/api/v1/publishing/releases/${r.id}/approve`, { eligibility: "public", confirm: draft.release.version, current: true });
  step("founder approves (browser, typed version, public)", approved.status === 200);
  step("approved but not published: still nothing delivered", (await access(tester)).artifacts.length === 0);
  step("an ordinary account cannot publish", (await tester.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: draft.release.version })).status === 403);
  const published = await founder.post(`/api/v1/publishing/releases/${r.id}/publish`, { confirm: draft.release.version, current: true });
  step("founder publishes (separate permission)", published.status === 200);
  step("published, no free window: not free, not for sale", (await access(tester)).state === "not-for-sale");

  const now = Date.now();
  const w = openWindow(s.db, { productId: draft.release.productId, editionId: draft.release.editionId, releaseId: r.id, startsAt: now, endsAt: now + 30 * 86_400_000, authorisedBy: "founder (rehearsal)", performedBy: "operator (rehearsal)" }, now);
  const open = await access(tester);
  step("window open: free for any signed-in account, no offer, no checkout", open.state === "free" && open.offers.length === 0 && open.artifacts.length === draft.artifacts.length, { state: open.state, files: open.artifacts.length, freeTesting: open.freeTesting });
  const delivered: { fileName: string; bytes: number; sha256: string }[] = [];
  for (const a of open.artifacts) {
    const dl = await tester.get(`/api/v1/downloads/${a.id}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const expected = draft.artifacts.find((x: { fileName: string }) => x.fileName === a.fileName);
    delivered.push({ fileName: a.fileName, bytes: bytes.length, sha256: sha256(bytes) });
    step(`tester download ${a.fileName}: exact bytes`, dl.status === 200 && sha256(bytes) === expected.sha256 && bytes.length === expected.sizeBytes, sha256(bytes));
  }
  step("signed out: refused", (await new Client(s.origin).get(`/api/v1/downloads/${open.artifacts[0]!.id}`)).status === 401);

  // Termination and re-opening (to leave the preview in the open state).
  terminateWindow(s.db, w.id, "Rehearsal: manual termination check.", { authorisedBy: "founder (rehearsal)", performedBy: "operator (rehearsal)" }, Date.now());
  step("terminated: delivery stops at once", (await access(tester)).artifacts.length === 0 && (await tester.get(`/api/v1/downloads/${open.artifacts[0]!.id}`)).status === 403);
  const w2 = openWindow(s.db, { productId: draft.release.productId, editionId: draft.release.editionId, releaseId: r.id, startsAt: Date.now(), endsAt: Date.now() + 30 * 86_400_000, authorisedBy: "founder (rehearsal)", performedBy: "operator (rehearsal)" }, Date.now());
  step("re-opened for the preview", listWindows(s.db, Date.now()).some((x) => x.id === w2.id && x.state === "open"));
  step("no purchase, payment or licence record created", (s.db.prepare("SELECT count(*) AS n FROM purchases").get() as { n: number }).n === 0);

  // Catalogue entry exactly as `npm run releases:sync` would generate it.
  const exported = exportReleaseRecords(s.db, Date.now());
  const products = JSON.parse(readFileSync(join(root, "catalogue/products.json"), "utf8"));
  const releases = JSON.parse(readFileSync(join(root, "catalogue/releases.json"), "utf8"));
  const sync = syncReleases(releases.releases as Release[], products.products.map((p: { id: string; registry: { centralId: string | null }; editions?: { id: string }[]; currentReleaseId?: string | null }) => ({ id: p.id, centralId: p.registry.centralId, editionIds: (p.editions ?? []).map((e) => e.id), currentReleaseId: p.currentReleaseId ?? null })), exported);
  mkdirSync(join(work, "catalogue"), { recursive: true });
  cpSync(join(root, "catalogue"), join(work, "catalogue"), { recursive: true });
  const nextProducts = { ...products, products: products.products.map((p: { id: string }) => (p.id in sync.currentReleaseIds ? { ...p, currentReleaseId: sync.currentReleaseIds[p.id] } : p)) };
  writeFileSync(join(work, "catalogue", "products.json"), JSON.stringify(nextProducts, null, 2) + "\n");
  writeFileSync(join(work, "catalogue", "releases.json"), JSON.stringify({ ...releases, releases: sync.releases }, null, 2) + "\n");
  const entry = sync.releases.find((x) => x.productId === draft.release.productId);
  writeFileSync(join(work, "publication-preview.json"), JSON.stringify({ release: entry, currentReleaseIds: sync.currentReleaseIds, notes: sync.notes, skipped: sync.skipped, delivered, window: listWindows(s.db, Date.now()) }, null, 2));
  step("catalogue entry generated", !!entry && sync.skipped.length === 0, sync.notes);
  console.log("\nPUBLICATION PREVIEW (catalogue/releases.json entry):\n" + JSON.stringify(entry, null, 2));
  s.server.close();
  await s.idp.stop?.();
  process.exit(process.exitCode ?? 0);
} else if (mode === "serve") {
  const s = await startStore(join(work, "catalogue"), resolve(arg("--static")!));
  // Same TEST identities and grants as the import phase (the database is the same).
  s.authority.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.approve"), "hcg-erp (TEST)", null);
  s.authority.grant(FOUNDER.sub, "hcg.store", featureEdition("store.release.publish"), "hcg-erp (TEST)", null);
  writeFileSync(join(work, "serve.json"), JSON.stringify({ origin: s.origin, issuer: s.idp.issuer }));
  console.log(JSON.stringify({ origin: s.origin }));
  // Sign-in for the screenshot browser: GET /rehearsal-login?as=tester|founder sets the next mock user.
  const control = createServer((req, res) => {
    const as = new URL(req.url ?? "/", "http://x").searchParams.get("as");
    s.idp.nextUser = as === "founder" ? FOUNDER : TESTER;
    res.end("ok");
  });
  control.listen(Number(arg("--control-port") ?? 4791), "127.0.0.1");
} else {
  console.error("Use: import | serve");
  process.exit(2);
}
