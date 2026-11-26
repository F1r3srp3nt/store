/**
 * TEST ONLY. Ship to Store end-to-end server for HCG Executable Maker: the mock HCG Connect provider (accepting the
 * Store's client AND a desktop client), the HCG Store server in test mode with publishing enabled (fixture catalogue,
 * TEST entitlement ledger standing in for HCG's central authority), and a control endpoint for the test script.
 * Never used for a real deployment.
 *
 *   node --experimental-strip-types server/test/ship-e2e-server.ts <info.json>
 *
 * Control API (127.0.0.1 only), standing in for HCG decisions and for a person in a browser:
 *   POST /grant      {sub, central, edition}   HCG grants an entitlement/permission
 *   POST /revoke-all {sub}                     HCG revokes everything for a person
 *   POST /token      {sub}                     an access token HCG Connect issued to the desktop client for <sub>
 *   POST /approve    {releaseId, eligibility, confirm, approver}   an approver signs in to the Store in a browser and approves
 *   POST /publish    {releaseId, confirm, publisher, supersede?}   a person (not the creator) publishes an approved public release
 *   POST /review     {releaseId, reviewer}     a person signs in to the Store in a browser, opens the draft's review page
 *                                              and presses "Download to review" for each verified file (SHA-256 of the bytes)
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreApp } from "../src/app";
import { parseStoreConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { featureEdition, TestLedgerAuthority } from "../src/entitlements";
import { STORE_CENTRAL_PRODUCT_ID } from "../src/publishing";
import { HcgConnectClient } from "../src/hcg-connect";
import { loadRegistry } from "../src/registry";
import { Client, FIXTURE_CATALOGUE, TEST_OFFERS } from "./harness";
import { MockHcgConnect } from "./mock-hcg-connect";

const infoFile = process.argv[2] ?? join(tmpdir(), "ship-e2e.json");
const MAKER_CLIENT = "99999999-8888-4777-8666-555555555555";
const idp = new MockHcgConnect();
idp.otherClients.add(MAKER_CLIENT);
idp.controlEndpoint = true;
await idp.start();

const storage = mkdtempSync(join(tmpdir(), "hcg-ship-e2e-private-"));
const reg = mkdtempSync(join(tmpdir(), "hcg-ship-e2e-registry-"));
writeFileSync(join(reg, "offers.json"), JSON.stringify(TEST_OFFERS));
writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));

const server = createServer();
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
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
  HCG_STORE_PAYMENT_PROVIDER: "test",
  HCG_STORE_PROTECTED_DOWNLOADS: "enabled",
  HCG_STORE_ARTIFACT_STORAGE_DIR: storage,
  HCG_STORE_STATIC_DIR: "",
  HCG_CATALOGUE_DIR: FIXTURE_CATALOGUE,
  HCG_STORE_OFFERS_FILE: join(reg, "offers.json"),
  HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
  HCG_STORE_PUBLISHING: "enabled",
  HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER_CLIENT,
  HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
  HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
  HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
  HCG_STORE_UPLOAD_CHUNK_MB: "1",
  HCG_STORE_UPLOAD_URL_TTL_SECONDS: process.env.UPLOAD_TTL ?? "900",
});
const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
const db = openDatabase(":memory:");
const now = () => Date.now();
const authority = new TestLedgerAuthority(db, now);
const app = createStoreApp({ cfg, db, registry, connect: new HcgConnectClient(cfg.hcgConnect!, fetch, now), authority, now });
// Fault injection for the retry test: the Nth upload chunk (counting from 1) is cut off mid-transfer once.
let chunkCount = 0;
const dropChunk = Number(process.env.DROP_CHUNK ?? "0");
// A slow link (each chunk waits SLOW_UPLOAD_MS), so the test can interrupt an upload half-way.
const slowMs = Number(process.env.SLOW_UPLOAD_MS ?? "0");
server.on("request", (req, res) => {
  if (req.method === "PUT" && req.url?.startsWith("/publishing-upload/")) {
    if (++chunkCount === dropChunk) {
      req.once("data", () => req.socket.destroy());
      return;
    }
    if (slowMs > 0) return void setTimeout(() => void app.handle(req, res), slowMs);
  }
  void app.handle(req, res);
});

const control = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const b = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  const out = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.url === "/grant") {
      // Publishing permissions are HCG's personal grants on hcg.store (store.publish, store.release.approve). Older
      // callers name them hcg.store.publish / hcg.store.approve; any edition they send is ignored.
      const feature = ({ "hcg.store.publish": "store.publish", "hcg.store.approve": "store.release.approve" } as Record<string, string>)[b.central!] ?? b.central!;
      if (feature === cfg.publishing.publisherCentralId || feature === cfg.publishing.approverCentralId || feature === cfg.publishing.publicationCentralId) {
        authority.grant(b.sub!, STORE_CENTRAL_PRODUCT_ID, featureEdition(feature), "e2e", null);
      } else authority.grant(b.sub!, b.central!, b.edition ?? "*", "e2e", null);
      return out(200, { ok: true });
    }
    if (req.url === "/revoke-all") { authority.revokeAll(b.sub!); return out(200, { ok: true }); }
    if (req.url === "/token") return out(200, { token: await idp.accessToken({ sub: b.sub!, email: `${b.sub}@example.test` }, MAKER_CLIENT) });
    if (req.url === "/review") {
      const c = await browserSignIn(b.reviewer!);
      const page = await c.get(`/publishing/releases/${b.releaseId}`);
      const html = await page.text();
      const downloads = [];
      for (const id of [...html.matchAll(/class="dl" data-id="(art-[a-f0-9]{16})"/g)].map((m) => m[1]!)) {
        const link = await c.post(`/api/v1/publishing/artifacts/${id}/download-url`, {});
        const body = (await link.json()) as { url?: string; basis?: string; error?: { code: string } };
        if (!link.ok || !body.url) { downloads.push({ id, status: link.status, error: body.error?.code }); continue; }
        const file = await fetch(body.url);
        const bytes = Buffer.from(await file.arrayBuffer());
        downloads.push({ id, status: file.status, basis: body.basis, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      return out(200, { reviewPageStatus: page.status, reviewPage: html, downloads });
    }
    if (req.url === "/approve") {
      // A person signs in to HCG Store in a browser (full redirect flow), then approves on the review page.
      const c = await browserSignIn(b.approver!);
      const page = await c.get(`/publishing/releases/${b.releaseId}`);
      const r = await c.post(`/api/v1/publishing/releases/${b.releaseId}/approve`, { eligibility: b.eligibility, confirm: b.confirm });
      return out(r.status, { reviewPageStatus: page.status, reviewPage: await page.text(), result: await r.json() });
    }
    if (req.url === "/publish") {
      // Publication is a separate, explicit step after approval, in a browser.
      const c = await browserSignIn(b.publisher!);
      const r = await c.post(`/api/v1/publishing/releases/${b.releaseId}/publish`, { confirm: b.confirm, supersede: String(b.supersede) === "true" });
      return out(r.status, { result: await r.json() });
    }
    out(404, {});
  } catch (e) {
    out(500, { error: String(e) });
  }
});
await new Promise<void>((ok) => control.listen(0, "127.0.0.1", ok));

/** A person signs in to HCG Store in a browser: the full redirect flow through the mock HCG Connect. */
async function browserSignIn(sub: string): Promise<Client> {
  const c = new Client(origin);
  idp.nextUser = { sub, email: `${sub}@example.test`, name: sub };
  const start = await c.get("/auth/login?return_to=/");
  const authz = await fetch(start.headers.get("location")!, { redirect: "manual" });
  await c.get(authz.headers.get("location")!.replace(origin, ""));
  return c;
}

writeFileSync(infoFile, JSON.stringify({
  storeOrigin: origin, issuer: idp.issuer, makerClientId: MAKER_CLIENT,
  control: `http://127.0.0.1:${(control.address() as { port: number }).port}`, storage,
}, null, 2));
console.log(`HCG Store (TEST, publishing) on ${origin}; mock HCG Connect ${idp.issuer}; info ${infoFile}`);
