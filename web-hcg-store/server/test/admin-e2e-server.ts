/**
 * TEST ONLY. HCG Store Control Center end-to-end server: the fixture build (dist-fixture/) served by the HCG Store
 * server in TEST mode on port 4177 with publishing ENABLED (E2E_PUBLISHING=uploads for the production-like mode), the
 * mock HCG Connect provider on 4178 (also accepting a TEST desktop client), and the TEST entitlement ledger standing in
 * for HCG's central permissions. Never used for a real deployment.
 *
 * Control (127.0.0.1 only, standing in for HCG's decisions):
 *   POST /__e2e/grant/:sub/:permission     store.publish | store.release.approve | store.release.publish | licence:<central>:<edition>
 *   POST /__e2e/desktop-token/:sub         an access token HCG Connect issued to the TEST desktop client for :sub
 *   POST /__e2e/founder/:sub              HCG's Founder policy (founder_owner_all_products) for :sub
 *   POST /__e2e/slow/:ms                   slow every upload chunk down (to interrupt an upload half-way)
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreApp } from "../src/app";
import { parseStoreConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { featureEdition, TestLedgerAuthority } from "../src/entitlements";
import { HcgConnectClient } from "../src/hcg-connect";
import { loadRegistry } from "../src/registry";
import { FIXTURE_CATALOGUE, ROOT } from "./harness";
import { MockHcgConnect } from "./mock-hcg-connect";

const STORE_PORT = Number(process.env.ADMIN_E2E_PORT ?? 4177);
const IDP_PORT = STORE_PORT + 1;
const DESKTOP_CLIENT = "99999999-8888-4777-8666-5555555555aa";

const idp = new MockHcgConnect();
idp.controlEndpoint = true;
idp.otherClients.add(DESKTOP_CLIENT);
await idp.start(IDP_PORT);

const storage = mkdtempSync(join(tmpdir(), "hcg-admin-e2e-private-"));
const reg = mkdtempSync(join(tmpdir(), "hcg-admin-e2e-registry-"));
writeFileSync(join(reg, "offers.json"), JSON.stringify({ offers: [] }));
writeFileSync(join(reg, "artifacts.json"), JSON.stringify({ artifacts: [] }));
const origin = `http://127.0.0.1:${STORE_PORT}`;
const cfg = parseStoreConfig({
  HCG_STORE_MODE: "test",
  HCG_STORE_PUBLIC_ORIGIN: origin,
  HCG_CONNECT_ISSUER: `${idp.origin}/auth/v1`,
  HCG_CONNECT_AUTHORIZATION_ENDPOINT: `${idp.origin}/auth/v1/oauth/authorize`,
  HCG_CONNECT_TOKEN_ENDPOINT: `${idp.origin}/auth/v1/oauth/token`,
  HCG_CONNECT_JWKS_URI: `${idp.origin}/auth/v1/.well-known/jwks.json`,
  HCG_CONNECT_CLIENT_ID: idp.clientId,
  HCG_CONNECT_REDIRECT_URI: `${origin}/auth/callback`,
  HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger",
  HCG_STORE_PAYMENT_PROVIDER: "none",
  HCG_STORE_PROTECTED_DOWNLOADS: "enabled",
  HCG_STORE_ARTIFACT_STORAGE_DIR: storage,
  HCG_STORE_STATIC_DIR: join(ROOT, "dist-fixture"),
  HCG_CATALOGUE_DIR: FIXTURE_CATALOGUE,
  HCG_STORE_OFFERS_FILE: join(reg, "offers.json"),
  HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
  HCG_STORE_PUBLISHING: process.env.E2E_PUBLISHING ?? "enabled",
  HCG_STORE_PUBLISHING_CLIENT_IDS: DESKTOP_CLIENT,
  HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
  HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
  ...(process.env.E2E_PUBLISHING === "uploads" ? {} : { HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish" }),
  HCG_STORE_UPLOAD_CHUNK_MB: "1",
});
const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
const db = openDatabase(":memory:");
const now = () => Date.now();
const authority = new TestLedgerAuthority(db, now);
const app = createStoreApp({ cfg, db, registry, connect: new HcgConnectClient(cfg.hcgConnect!), authority, now });
let slowMs = 0;

createServer(async (req, res) => {
  const url = req.url ?? "";
  let m: RegExpExecArray | null;
  if (req.method === "POST" && (m = /^\/__e2e\/grant\/([^/]+)\/([^/]+)$/.exec(url))) {
    const [sub, what] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
    if (what.startsWith("licence:")) { const [, central, edition] = what.split(":"); authority.grant(sub, central!, edition!, "e2e", null); }
    else authority.grant(sub, "hcg.store", featureEdition(what), "e2e", null);
    return void res.writeHead(204).end();
  }
  if (req.method === "POST" && (m = /^\/__e2e\/desktop-token\/([^/]+)$/.exec(url))) {
    const sub = decodeURIComponent(m[1]!);
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ token: await idp.accessToken({ sub, email: `${sub}@example.test`, name: sub }, DESKTOP_CLIENT) }));
  }
  // TEST stand-in for HCG's Owner activating the Founder policy (founder_owner_all_products) for a subject.
  if (req.method === "POST" && (m = /^\/__e2e\/founder\/([^/]+)$/.exec(url))) { authority.setFounderPolicy(decodeURIComponent(m[1]!), true); return void res.writeHead(204).end(); }
  if (req.method === "POST" && (m = /^\/__e2e\/slow\/(\d+)$/.exec(url))) { slowMs = Number(m[1]); return void res.writeHead(204).end(); }
  if (req.method === "PUT" && url.startsWith("/publishing-upload/") && slowMs > 0) return void setTimeout(() => void app.handle(req, res), slowMs);
  void app.handle(req, res);
}).listen(STORE_PORT, "127.0.0.1", () => console.log(`TEST HCG Store (Control Center) on ${origin}, mock HCG Connect on ${idp.origin}`));
