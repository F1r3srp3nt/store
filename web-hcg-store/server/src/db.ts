import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local HCG Store state. It holds NO user accounts or roles: people are identified only by the
 * HCG Connect subject (`sub`). Purchases and payment events are the Store's own responsibility;
 * entitlements belong to HCG (see entitlements.ts) — the `test_entitlements` table exists only
 * for the test-mode ledger.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     email TEXT,
     name TEXT,
     refresh_token TEXT,
     access_token TEXT,
     access_expires_at INTEGER NOT NULL,
     central_checked_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     ended_at INTEGER,
     ended_reason TEXT
   );
   CREATE INDEX sessions_sub ON sessions(sub);
   CREATE TABLE login_attempts (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     return_to TEXT NOT NULL,
     purpose TEXT NOT NULL,
     purpose_data TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE checkout_sessions (
     id TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     offer_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     status TEXT NOT NULL,
     provider TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE purchases (
     id TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     offer_id TEXT NOT NULL,
     checkout_id TEXT NOT NULL UNIQUE,
     provider TEXT NOT NULL,
     provider_payment_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     current_period_end INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(provider, provider_payment_id)
   );
   CREATE INDEX purchases_sub ON purchases(sub);
   CREATE TABLE payment_events (
     provider TEXT NOT NULL,
     event_id TEXT NOT NULL,
     type TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     PRIMARY KEY (provider, event_id)
   );
   CREATE TABLE test_entitlements (
     sub TEXT NOT NULL,
     product_id TEXT NOT NULL,
     edition TEXT NOT NULL,
     source TEXT NOT NULL,
     status TEXT NOT NULL,
     expires_at INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (sub, product_id, edition, source)
   );
   CREATE TABLE repo_tokens (
     token_hash TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL,
     session_id_hash TEXT NOT NULL,
     sub TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   );`,
  // Ship to Store (publishing). Draft products/releases live here, never in the public catalogue.
  `CREATE TABLE pub_products (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE pub_releases (
     id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     product_source TEXT NOT NULL,
     edition_id TEXT,
     version TEXT NOT NULL,
     build TEXT NOT NULL,
     channel TEXT NOT NULL,
     release_notes TEXT NOT NULL,
     compatibility TEXT NOT NULL,
     distribution TEXT NOT NULL,
     requested_eligibility TEXT NOT NULL,
     destinations TEXT NOT NULL,
     status TEXT NOT NULL,
     approved_eligibility TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     submitted_at INTEGER,
     approved_by TEXT,
     approved_at INTEGER,
     withdrawn_reason TEXT,
     UNIQUE (product_id, edition_id, version, build)
   );
   CREATE TABLE pub_artifacts (
     id TEXT PRIMARY KEY,
     release_id TEXT NOT NULL REFERENCES pub_releases(id),
     file_name TEXT NOT NULL,
     platform TEXT NOT NULL,
     format TEXT NOT NULL,
     architectures TEXT NOT NULL,
     minimum_os TEXT,
     size_bytes INTEGER NOT NULL,
     declared_sha256 TEXT NOT NULL,
     sha256 TEXT,
     status TEXT NOT NULL,
     storage_key TEXT,
     content_type TEXT NOT NULL,
     validation TEXT,
     signing_reported TEXT NOT NULL,
     package TEXT,
     created_at INTEGER NOT NULL,
     completed_at INTEGER,
     UNIQUE (release_id, file_name)
   );
   CREATE TABLE pub_uploads (
     artifact_id TEXT PRIMARY KEY REFERENCES pub_artifacts(id),
     received_bytes INTEGER NOT NULL,
     staging_key TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE pub_download_grants (
     id_hash TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     access_token TEXT,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE pub_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     release_id TEXT,
     artifact_id TEXT,
     detail TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL
   );
   -- The audit log is append-only.
   CREATE TRIGGER pub_audit_no_update BEFORE UPDATE ON pub_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
   CREATE TRIGGER pub_audit_no_delete BEFORE DELETE ON pub_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
   -- A verified artifact is immutable: its hash, size, name and storage location never change, and it is never deleted.
   CREATE TRIGGER pub_artifact_immutable BEFORE UPDATE ON pub_artifacts
     WHEN OLD.status = 'verified' AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.storage_key IS NOT OLD.storage_key OR NEW.size_bytes IS NOT OLD.size_bytes
          OR NEW.file_name IS NOT OLD.file_name OR NEW.release_id IS NOT OLD.release_id OR NEW.status NOT IN ('verified', 'removed'))
     BEGIN SELECT RAISE(ABORT, 'verified artifacts are immutable'); END;
   CREATE TRIGGER pub_artifact_no_delete BEFORE DELETE ON pub_artifacts WHEN OLD.status IN ('verified', 'removed')
     BEGIN SELECT RAISE(ABORT, 'verified artifacts are never deleted'); END;`,
];

export type Db = DatabaseSync;

export function openDatabase(dataDir: string): Db {
  let file = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = join(dataDir, "hcg-store.sqlite");
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

/** Run fn inside a transaction (node:sqlite is synchronous, so this is atomic for this process). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
