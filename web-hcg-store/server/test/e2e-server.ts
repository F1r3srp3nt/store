/**
 * TEST ONLY. Starts the mock HCG Connect provider (port 4176) and the HCG Store server in test mode
 * (port 4175) serving the fixture build (dist-fixture/) with TEST offers and private TEST files.
 * Used by the Playwright suite (e2e/account.spec.ts). Never used for a real deployment.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreApp } from "../src/app";
import { parseStoreConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { TestLedgerAuthority } from "../src/entitlements";
import { HcgConnectClient } from "../src/hcg-connect";
import { loadRegistry } from "../src/registry";
import { FILES, FIXTURE_CATALOGUE, ROOT, TEST_OFFERS, testArtifacts } from "./harness";
import { MockHcgConnect } from "./mock-hcg-connect";

const STORE_PORT = 4175;
const IDP_PORT = 4176;

const idp = new MockHcgConnect();
idp.nextUser = { sub: "e2e-alice", email: "alice@example.test", name: "Alice (test)" };
idp.controlEndpoint = true;
await idp.start(IDP_PORT);

const storage = mkdtempSync(join(tmpdir(), "hcg-store-e2e-private-"));
for (const [k, v] of Object.entries(FILES)) {
  mkdirSync(join(storage, k, ".."), { recursive: true });
  writeFileSync(join(storage, k), v);
}
const reg = mkdtempSync(join(tmpdir(), "hcg-store-e2e-registry-"));
writeFileSync(join(reg, "offers.json"), JSON.stringify(TEST_OFFERS));
writeFileSync(join(reg, "artifacts.json"), JSON.stringify(testArtifacts()));

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
  HCG_STORE_PAYMENT_PROVIDER: "test",
  HCG_STORE_PROTECTED_DOWNLOADS: process.env.E2E_DOWNLOADS ?? "enabled",
  HCG_STORE_ARTIFACT_STORAGE_DIR: storage,
  HCG_STORE_STATIC_DIR: join(ROOT, "dist-fixture"),
  HCG_CATALOGUE_DIR: FIXTURE_CATALOGUE,
  HCG_STORE_OFFERS_FILE: join(reg, "offers.json"),
  HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
});
const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
const db = openDatabase(":memory:");
const now = () => Date.now();
const authority = new TestLedgerAuthority(db, now);
const app = createStoreApp({
  cfg,
  db,
  registry,
  connect: new HcgConnectClient(cfg.hcgConnect!),
  authority,
  now,
});
createServer((req, res) => {
  // TEST server only: stands in for HCG's Owner granting the Owner-access policy to a subject.
  const owner = /^\/__e2e\/owner-access\/([^/]+)$/.exec(req.url ?? "");
  if (owner && req.method === "POST") {
    authority.setFounderPolicy(decodeURIComponent(owner[1]!), true);
    res.writeHead(204).end();
    return;
  }
  void app.handle(req, res);
}).listen(STORE_PORT, "127.0.0.1", () => {
  console.log(`TEST HCG Store server on ${origin} (mock HCG Connect on ${idp.origin})`);
});
