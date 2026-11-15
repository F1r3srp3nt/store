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
