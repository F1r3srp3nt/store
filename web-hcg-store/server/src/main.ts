/**
 * Entry point: `node server-dist/main.mjs` (or `npm run server:dev`). Configuration comes from the
 * environment; see .env.server.example and docs/ACCESS.md.
 */
import { createStoreApp, listen } from "./app";
import { ConfigError, parseStoreConfig } from "./config";
import { openDatabase, recordAuthEvent } from "./db";
import { HcgEcosystemAuthority, NoAuthority, TestLedgerAuthority, type EntitlementAuthority } from "./entitlements";
import { CentralGrantOutbox } from "./grants";
import { HcgConnectClient } from "./hcg-connect";
import { loadRegistry, RegistryError } from "./registry";

function start() {
  const cfg = parseStoreConfig(process.env);
  const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: cfg.mode === "test" });
  for (const w of registry.warnings) console.warn(`⚠ ${w}`);
  const db = openDatabase(cfg.dataDir);
  const now = () => Date.now();
  const connect = cfg.hcgConnect ? new HcgConnectClient(cfg.hcgConnect) : null;
  const authority: EntitlementAuthority =
    cfg.entitlementAuthority === "test-ledger"
      ? new TestLedgerAuthority(db, now)
      : cfg.entitlementAuthority === "hcg-ecosystem"
        ? new HcgEcosystemAuthority(cfg.ecosystem!.baseUrl)
        : new NoAuthority();
  const outbox = new CentralGrantOutbox(db, now, cfg.grants);
  if (outbox.enabled) setInterval(() => void outbox.deliver().catch(() => undefined), 30_000).unref();
  const app = createStoreApp({ cfg, db, registry, connect, authority, now, outbox });
  recordAuthEvent(db, now(), "server_started", { detail: { mode: cfg.mode, hcgConnectClientId: connect?.clientId ?? null } });
  return listen(app, cfg.port, cfg.host).then(() => {
    console.log(`HCG Store server (${cfg.mode} mode) on http://${cfg.host}:${cfg.port}`);
    console.log(`  HCG Connect: ${connect ? "configured" : "not configured"} · entitlements: ${authority.kind} · payments: ${cfg.paymentProvider} · central grants: ${outbox.enabled ? `${outbox.environment} (pending ${outbox.pending()})` : "not configured"} · protected downloads: ${cfg.protectedDownloads ? "enabled" : "disabled"}`);
  });
}

try {
  await start();
} catch (e) {
  if (e instanceof ConfigError || e instanceof RegistryError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
