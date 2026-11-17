/**
 * Entry point: `node server-dist/main.mjs` (or `npm run server:dev`). Configuration comes from the
 * environment; see .env.server.example and docs/ACCESS.md.
 */
import { createStoreApp, listen } from "./app";
import { backupDatabase } from "./backup";
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
  if (cfg.backup && cfg.dataDir !== ":memory:") {
    const backup = cfg.backup;
    const run = () => {
      try {
        const r = backupDatabase(db, backup.dir, backup.keep, now());
        console.log(`Database backup written (${r.file.split("/").pop()}); ${r.removed.length} older copies removed.`);
      } catch (e) {
        console.error(`Database backup FAILED: ${(e as Error).message}`);
      }
    };
    setTimeout(run, 60_000).unref();
    setInterval(run, 24 * 3600 * 1000).unref();
  }
  recordAuthEvent(db, now(), "server_started", { detail: { mode: cfg.mode, hcgConnectClientId: connect?.clientId ?? null } });
  return listen(app, cfg.port, cfg.host).then((server) => {
    // Clean stop on deploys and restarts: finish in-flight requests, then close the database so the
    // SQLite write-ahead log is checkpointed. Hosts send SIGINT (Fly.io's default) or SIGTERM.
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal}: stopping HCG Store server`);
      setTimeout(() => process.exit(0), 8000).unref();
      server.close(() => {
        db.close();
        process.exit(0);
      });
      server.closeIdleConnections();
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
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
