/**
 * TEST ONLY. HCG Store's Sileo payment provider for testing on a real jailbroken iPhone, without production, real
 * accounts or money (docs/SILEO-PAYMENT-PROVIDER.md, "Testing on your iPhone", stage A).
 *
 *   DEVICE_ORIGIN=https://<your-tunnel-host> npm run sileo:device-test
 *
 * - One public port (PORT, default 4180) behind an HTTPS tunnel. It serves the TEST HCG Store (fixture catalogue and
 *   site from dist-fixture/) and, under /auth/v1/, the mock HCG Connect provider: sign-in is a TEST identity, labelled as
 *   such, never a real HCG account.
 * - The payment provider is in internal testing, with an internal test source at
 *   <DEVICE_ORIGIN>/api/sileo/v1/internal-source/ listing one paid TEST package (EUR 9.99, TEST provider: no money).
 *   The package is a real, harmless .deb that installs one text file (tiny-deb.ts).
 * - A control port on 127.0.0.1 only (CONTROL_PORT, default 4181, never tunnelled): POST /refund refunds the TEST
 *   account's latest purchase through the TEST provider's signed webhook; GET /state prints what the Store holds.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreApp } from "../src/app";
import { parseStoreConfig } from "../src/config";
import { sha256Hex } from "../src/crypto";
import { openDatabase } from "../src/db";
import { TestLedgerAuthority } from "../src/entitlements";
import { HcgConnectClient } from "../src/hcg-connect";
import { signTestEvent } from "../src/payments";
import { loadRegistry } from "../src/registry";
import { FIXTURE_CATALOGUE, ROOT, TEST_OFFERS } from "./harness";
import { MockHcgConnect } from "./mock-hcg-connect";
import { buildTestDeb } from "./tiny-deb";

const ORIGIN = (process.env.DEVICE_ORIGIN ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/i.test(ORIGIN)) {
  console.error("Set DEVICE_ORIGIN to the https origin of your tunnel, e.g. DEVICE_ORIGIN=https://example.trycloudflare.com");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 4180);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4181);
const PKG = "com.example.fixture.quasar.unleashed";
const TESTER = { sub: "device-tester", email: "device-tester@example.test", name: "TEST device tester" };

// Mock HCG Connect on a private port; the browser reaches it through the tunnel under /auth/v1/.
const idp = new MockHcgConnect();
await idp.start(0);
const idpPort = Number(new URL(idp.origin).port);
idp.origin = ORIGIN; // tokens are issued for the tunnel's origin
idp.nextUser = TESTER;

// The TEST package and the registry entry pinning its SHA-256.
const storage = mkdtempSync(join(tmpdir(), "hcg-device-private-"));
const deb = buildTestDeb({ pkg: PKG, version: "1.0.0", name: "HCG Store TEST package" });
mkdirSync(join(storage, "device"), { recursive: true });
writeFileSync(join(storage, "device/test-1.0.0-arm64.deb"), deb);
const reg = mkdtempSync(join(tmpdir(), "hcg-device-registry-"));
writeFileSync(join(reg, "offers.json"), JSON.stringify(TEST_OFFERS));
writeFileSync(
  join(reg, "artifacts.json"),
  JSON.stringify({
    artifacts: [{
      id: "fixture-quasar-unleashed-1-0-0-arm64", productId: "fixture-quasar-shell", releaseId: "fixture-quasar-shell-1-0-0", catalogueArtifactId: "unleashed-rootless",
      editionId: "unleashed", fileName: `${PKG}_1.0.0_iphoneos-arm64.deb`, contentType: "application/vnd.debian.binary-package", sha256: sha256Hex(deb),
      storageKey: "device/test-1.0.0-arm64.deb", deliveryApproved: true, testOnly: true,
    }],
  }),
);

const cfg = parseStoreConfig({
  HCG_STORE_MODE: "test",
  HCG_STORE_PUBLIC_ORIGIN: ORIGIN,
  HCG_CONNECT_ISSUER: `${ORIGIN}/auth/v1`,
  HCG_CONNECT_AUTHORIZATION_ENDPOINT: `${ORIGIN}/auth/v1/oauth/authorize`,
  // Server-to-server calls stay on this machine.
  HCG_CONNECT_TOKEN_ENDPOINT: `http://127.0.0.1:${idpPort}/auth/v1/oauth/token`,
  HCG_CONNECT_JWKS_URI: `http://127.0.0.1:${idpPort}/auth/v1/.well-known/jwks.json`,
  HCG_CONNECT_CLIENT_ID: idp.clientId,
  HCG_CONNECT_REDIRECT_URI: `${ORIGIN}/auth/callback`,
  HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger",
  HCG_STORE_PAYMENT_PROVIDER: "test",
  HCG_STORE_PROTECTED_DOWNLOADS: "enabled",
  HCG_STORE_ARTIFACT_STORAGE_DIR: storage,
  HCG_STORE_STATIC_DIR: join(ROOT, "dist-fixture"),
  HCG_CATALOGUE_DIR: FIXTURE_CATALOGUE,
  HCG_STORE_OFFERS_FILE: join(reg, "offers.json"),
  HCG_STORE_ARTIFACTS_FILE: join(reg, "artifacts.json"),
});
const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
const db = openDatabase(":memory:");
const authority = new TestLedgerAuthority(db, Date.now);
// The TEST identity stands in for the Founder: internal testing admits only the Founder and HCG Store staff.
authority.setFounderPolicy(TESTER.sub, true);
const app = createStoreApp({ cfg, db, registry, connect: new HcgConnectClient(cfg.hcgConnect!), authority, now: Date.now });

const source = `${ORIGIN}/api/sileo/v1/internal-source/`;
const profile = app.commerce.profile();
app.commerce.updateProfile("device-test-operator", { ...profile.value, availability: "internal", paymentMode: "test", repositories: [source] }, profile.revision);
app.commerce.upsertChannel("device-test-operator", PKG, {
  productId: "fixture-quasar-shell", editionId: "unleashed", status: "active", access: "paid", architectures: ["iphoneos-arm64"],
  minIos: "15.0", maxIos: null, updatePolicy: "all-updates", repository: source,
});

createServer((req, res) => {
  if ((req.url ?? "").startsWith("/auth/v1/")) {
    const up = httpRequest({ host: "127.0.0.1", port: idpPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    return void req.pipe(up);
  }
  void app.handle(req, res);
}).listen(PORT, "127.0.0.1");

createServer(async (req, res) => {
  const t = Date.now();
  if (req.method === "POST" && req.url === "/refund") {
    const p = app.ledger.purchasesFor(TESTER.sub).find((x) => x.status === "paid");
    if (!p) return void res.writeHead(404).end("No paid TEST purchase.\n");
    const raw = JSON.stringify({ id: `evt_refund_${t}`, type: "payment.refunded", checkoutId: p.checkout_id, paymentId: p.provider_payment_id, amount: p.amount, currency: p.currency });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/payments/webhook/test`, { method: "POST", headers: { "hcg-test-signature": signTestEvent(cfg.testPaymentWebhookSecret!, raw, t) }, body: raw });
    return void res.writeHead(200).end(`Refund event: ${r.status} ${await r.text()}\n`);
  }
  if (req.method === "GET" && req.url === "/state") {
    const state = {
      purchases: app.ledger.purchasesFor(TESTER.sub).map((p) => ({ id: p.id, status: p.status, channel: p.channel, amount: p.amount, currency: p.currency })),
      packageManagers: (db.prepare("SELECT ref, client, device_model, revoked_at FROM repo_tokens").all() as unknown[]),
      downloadGrants: (db.prepare("SELECT artifact_id, version, architecture, used_at IS NOT NULL AS used, expires_at FROM repo_download_grants ORDER BY created_at DESC LIMIT 10").all() as unknown[]),
    };
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(state, null, 2) + "\n");
  }
  res.writeHead(404).end();
}).listen(CONTROL_PORT, "127.0.0.1");

console.log(`TEST HCG Store (Sileo payment provider, internal testing) for ${ORIGIN}`);
console.log(`  Add this source in Sileo:  ${source}`);
console.log(`  Library (TEST sign-in):    ${ORIGIN}/library`);
console.log(`  TEST package:              ${PKG} 1.0.0 (iphoneos-arm64), SHA-256 ${sha256Hex(deb)}`);
console.log(`  Local controls:            curl -X POST http://127.0.0.1:${CONTROL_PORT}/refund   ·   curl http://127.0.0.1:${CONTROL_PORT}/state`);
console.log(`  Listening on http://127.0.0.1:${PORT} (point your tunnel here). No money moves; sign-in is a TEST identity.`);
