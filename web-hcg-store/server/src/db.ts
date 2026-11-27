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
  // 2: out-of-order payment events and the outbox of purchase grants for HCG (decision D5).
  `CREATE TABLE checkout_reversals (
     checkout_id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     received_at INTEGER NOT NULL
   );
   CREATE TABLE central_grants (
     purchase_key TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     product_id TEXT NOT NULL,
     edition TEXT,
     state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
     reason TEXT,
     starts_at INTEGER NOT NULL,
     ends_at INTEGER,
     revision INTEGER NOT NULL,
     delivered_revision INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX central_grants_pending ON central_grants(next_attempt_at) WHERE delivered_revision < revision;`,
  // 3: Ship to Store (publishing). Draft products/releases live here, never in the public catalogue.
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
  // 4: Ship to Shop: what the uploader said the file is (device build, simulator build, installer…), checked against
  // what the Store finds; and one release per product/edition/version/build also when the product has no editions
  // (SQLite treats NULL edition IDs as distinct in the table's UNIQUE constraint).
  `ALTER TABLE pub_artifacts ADD COLUMN declared_kind TEXT;
   CREATE UNIQUE INDEX pub_releases_one_per_build ON pub_releases (product_id, COALESCE(edition_id, ''), version, build);`,
  // 5: HCG Connect evidence. When sign-in confirmed the account with HCG's /me, and an audit trail of
  // sign-in, refresh and logout events. Neither ever holds a token.
  `ALTER TABLE sessions ADD COLUMN account_confirmed_at INTEGER;
   CREATE TABLE auth_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     type TEXT NOT NULL,
     session_ref TEXT,
     sub TEXT,
     detail TEXT
   );
   CREATE INDEX auth_events_at ON auth_events(at);`,
  // 6: a purchase grant names the central features it includes (main-site plan: a grant covers only the purchased
  // product, edition and features).
  `ALTER TABLE central_grants ADD COLUMN features TEXT NOT NULL DEFAULT '[]';`,
  // 7: Store profiles (profiles.ts): presentation only (display name, designation), keyed to a verified HCG subject;
  // grants nothing. Changes are append-only events recording who authorised and who performed them.
  `CREATE TABLE store_profiles (
     sub TEXT PRIMARY KEY,
     display_name TEXT,
     designation TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE store_profile_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     sub TEXT NOT NULL,
     action TEXT NOT NULL,
     before_json TEXT,
     after_json TEXT NOT NULL,
     authorised_by TEXT NOT NULL,
     performed_by TEXT NOT NULL
   );
   CREATE TRIGGER store_profile_events_no_update BEFORE UPDATE ON store_profile_events BEGIN SELECT RAISE(ABORT, 'profile events are append-only'); END;
   CREATE TRIGGER store_profile_events_no_delete BEFORE DELETE ON store_profile_events BEGIN SELECT RAISE(ABORT, 'profile events are append-only'); END;`,
  // 8: Release Manager. Build provenance reported with each file (source commit, build provider, toolchain, the
  // uploader's validation report), and an explicit publication step after approval: published, then superseded by a
  // later published release (only when the person publishing chooses so). Approved releases are not delivered until
  // published.
  `ALTER TABLE pub_artifacts ADD COLUMN provenance TEXT;
   ALTER TABLE pub_releases ADD COLUMN published_at INTEGER;
   ALTER TABLE pub_releases ADD COLUMN published_by TEXT;
   ALTER TABLE pub_releases ADD COLUMN superseded_by TEXT;`,
  // 9: Free testing windows (free-windows.ts): a free public release is delivered only while a window is open
  // (unless its edition is permanently free). Windows are opened, extended and terminated only by the operator path,
  // with who authorised and who performed each change in an append-only log. Releases record their known
  // limitations and, for an operator import, where they came from. A window can be anchored to a release's
  // publication (starts when it is published, lasts duration_ms). Founder-operated release exceptions
  // (release-exceptions.ts): one named person may submit, approve and publish ONE specific release with ONE exact set
  // of files; recorded with who authorised it, revocable, never deleted.
  `CREATE TABLE free_windows (
     id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     edition_id TEXT,
     release_id TEXT,
     starts_at INTEGER,
     ends_at INTEGER,
     anchor TEXT NOT NULL DEFAULT 'fixed',
     duration_ms INTEGER,
     terminated_at INTEGER,
     terminated_reason TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE free_window_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     window_id TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL,
     authorised_by TEXT NOT NULL,
     performed_by TEXT NOT NULL
   );
   CREATE TRIGGER free_window_events_no_update BEFORE UPDATE ON free_window_events BEGIN SELECT RAISE(ABORT, 'free window events are append-only'); END;
   CREATE TRIGGER free_window_events_no_delete BEFORE DELETE ON free_window_events BEGIN SELECT RAISE(ABORT, 'free window events are append-only'); END;
   CREATE TABLE release_exceptions (
     id TEXT PRIMARY KEY,
     release_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     subject TEXT NOT NULL,
     artifact_digest TEXT NOT NULL,
     reason TEXT NOT NULL,
     authorised_by TEXT NOT NULL,
     performed_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER,
     revoked_reason TEXT
   );
   CREATE TRIGGER release_exceptions_no_delete BEFORE DELETE ON release_exceptions BEGIN SELECT RAISE(ABORT, 'release exceptions are kept'); END;
   CREATE TRIGGER release_exceptions_only_revoke BEFORE UPDATE ON release_exceptions
     WHEN NEW.id IS NOT OLD.id OR NEW.release_id IS NOT OLD.release_id OR NEW.kind IS NOT OLD.kind OR NEW.subject IS NOT OLD.subject
       OR NEW.artifact_digest IS NOT OLD.artifact_digest OR NEW.reason IS NOT OLD.reason OR NEW.authorised_by IS NOT OLD.authorised_by
       OR NEW.performed_by IS NOT OLD.performed_by OR NEW.created_at IS NOT OLD.created_at OR OLD.revoked_at IS NOT NULL
     BEGIN SELECT RAISE(ABORT, 'a release exception can only be revoked, once'); END;
   ALTER TABLE pub_releases ADD COLUMN known_limitations TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE pub_releases ADD COLUMN imported_from TEXT;`,
  // 10: Release lifecycle dimensions and explicit current releases (release-lifecycle.ts).
  // - availability is separate from review/publication: available · disabled (restorable) · archived (hidden) ·
  //   revoked (final). Only "available" releases are ever delivered to customers.
  // - pub_current: the explicitly selected current release of each distribution TARGET (product, edition, platform,
  //   architecture, channel). Publishing a macOS, ARM64 or beta build changes only its own targets. Never inferred
  //   from version numbers. Backfilled from releases already published (newest publication per target).
  // - revision: every change to a release or a draft product bumps it (triggers), so clients can detect conflicts
  //   (If-Match) instead of silently overwriting another client's change.
  // - Draft products get revisioned metadata (Store-only until HCG registers the product centrally).
  `ALTER TABLE pub_releases ADD COLUMN availability TEXT NOT NULL DEFAULT 'available';
   ALTER TABLE pub_releases ADD COLUMN availability_reason TEXT;
   ALTER TABLE pub_releases ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE pub_releases ADD COLUMN supersede_on_publish INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pub_releases ADD COLUMN upload_source TEXT;
   CREATE TABLE pub_current (
     product_id TEXT NOT NULL,
     edition_key TEXT NOT NULL,
     platform TEXT NOT NULL,
     arch TEXT NOT NULL,
     channel TEXT NOT NULL,
     release_id TEXT NOT NULL REFERENCES pub_releases(id),
     selected_at INTEGER NOT NULL,
     selected_by TEXT NOT NULL,
     PRIMARY KEY (product_id, edition_key, platform, arch, channel)
   );
   INSERT OR REPLACE INTO pub_current (product_id, edition_key, platform, arch, channel, release_id, selected_at, selected_by)
     SELECT r.product_id, COALESCE(r.edition_id, ''), a.platform, j.value, r.channel, r.id, r.published_at, 'migration-10'
     FROM pub_releases r JOIN pub_artifacts a ON a.release_id = r.id
       JOIN json_each(CASE WHEN a.architectures IN ('[]', '') THEN '["any"]' ELSE a.architectures END) j
     WHERE r.status = 'published' AND r.approved_eligibility = 'public' AND a.status = 'verified' AND a.format <> 'aab'
     ORDER BY r.published_at, r.id;
   ALTER TABLE pub_products ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE pub_products ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE pub_products ADD COLUMN updated_at INTEGER;
   ALTER TABLE pub_products ADD COLUMN updated_by TEXT;
   CREATE TRIGGER pub_release_revision AFTER UPDATE ON pub_releases WHEN NEW.revision = OLD.revision
     BEGIN UPDATE pub_releases SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
   CREATE TRIGGER pub_release_revision_files_new AFTER INSERT ON pub_artifacts
     BEGIN UPDATE pub_releases SET revision = revision + 1 WHERE id = NEW.release_id; END;
   CREATE TRIGGER pub_release_revision_files AFTER UPDATE OF status ON pub_artifacts WHEN NEW.status IS NOT OLD.status
     BEGIN UPDATE pub_releases SET revision = revision + 1 WHERE id = NEW.release_id; END;
   CREATE TRIGGER pub_product_revision AFTER UPDATE ON pub_products WHEN NEW.revision = OLD.revision
     BEGIN UPDATE pub_products SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
   CREATE TRIGGER pub_release_revoked_final BEFORE UPDATE OF availability ON pub_releases
     WHEN OLD.availability = 'revoked' AND NEW.availability <> 'revoked'
     BEGIN SELECT RAISE(ABORT, 'a revoked release stays revoked'); END;`,
  // 11: Distribution Studio (HCG Executable Maker). What the submitter asks for at publication: make current (the
  // catalogue's current release) and whether to supersede the previous compatible release; recorded with the draft,
  // applied only by the person who publishes. Draft products' descriptive fields live in pub_products.metadata (10).
  `ALTER TABLE pub_releases ADD COLUMN publication_request TEXT;`,
  // 12: Sileo / Zebra payment provider (sileo.ts) and the commerce administration around it (commerce.ts).
  // - Package-manager credentials: a public reference (pms_…) for the account page, an expiry, last use, the device
  //   model and a keyed hash of the device identifier (HMAC with the Store's secret key; the identifier itself is
  //   never stored), and why a credential was revoked.
  // - Download grants: single use, short-lived, bound to one artifact and its SHA-256, the package version and
  //   architecture asked for, and the credential that asked. Only the grant's hash is stored.
  // - Package-manager checkouts: the checkout, the credential and package it came from, and the hash of the one-time
  //   page link handed to Sileo.
  // - Commerce: provider profile and gates (commerce_settings), the repository-package distribution channel
  //   (repo_packages), third-party developers, product ownership and commission agreements, and an audit trail.
  `ALTER TABLE repo_tokens ADD COLUMN ref TEXT;
   ALTER TABLE repo_tokens ADD COLUMN device_hash TEXT;
   ALTER TABLE repo_tokens ADD COLUMN device_model TEXT;
   ALTER TABLE repo_tokens ADD COLUMN client TEXT;
   ALTER TABLE repo_tokens ADD COLUMN last_used_at INTEGER;
   ALTER TABLE repo_tokens ADD COLUMN expires_at INTEGER;
   ALTER TABLE repo_tokens ADD COLUMN revoked_reason TEXT;
   UPDATE repo_tokens SET ref = 'pms_legacy_' || rowid WHERE ref IS NULL;
   CREATE UNIQUE INDEX repo_tokens_ref ON repo_tokens(ref);
   CREATE INDEX repo_tokens_sub ON repo_tokens(sub);
   CREATE TABLE repo_download_grants (
     id_hash TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL,
     sub TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     package_id TEXT NOT NULL,
     version TEXT NOT NULL,
     architecture TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   );
   CREATE INDEX repo_download_grants_expiry ON repo_download_grants(expires_at);
   ALTER TABLE checkout_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
   ALTER TABLE purchases ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
   ALTER TABLE purchases ADD COLUMN version_at_purchase TEXT;
   ALTER TABLE checkout_sessions ADD COLUMN version_at_purchase TEXT;
   CREATE TABLE pm_checkouts (
     checkout_id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL,
     package_id TEXT NOT NULL,
     link_hash TEXT NOT NULL UNIQUE,
     link_expires_at INTEGER NOT NULL,
     completed_page_at INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE commerce_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT
   );
   CREATE TABLE repo_packages (
     package_id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     edition_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended')),
     access TEXT NOT NULL CHECK (access IN ('free', 'account', 'paid')),
     architectures TEXT NOT NULL,
     min_ios TEXT,
     max_ios TEXT,
     update_policy TEXT NOT NULL CHECK (update_policy IN ('all-updates', 'same-major')),
     repository TEXT NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE TABLE developers (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended')),
     onboarding TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE TABLE product_developers (
     product_id TEXT PRIMARY KEY,
     developer_id TEXT NOT NULL REFERENCES developers(id),
     since INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE TABLE developer_agreements (
     id TEXT PRIMARY KEY,
     developer_id TEXT NOT NULL REFERENCES developers(id),
     commission_bps INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
     effective_from INTEGER NOT NULL,
     effective_to INTEGER,
     status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'ended')),
     note TEXT,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE TABLE commerce_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   );`,
];

/**
 * Audit trail for sign-in, refresh and logout. `session_ref` is the first 12 hex characters of the
 * session's ID hash, enough to follow one session; `detail` is small JSON with outcomes and reasons.
 * Never pass a token, code, verifier or cookie value here.
 */
export function recordAuthEvent(db: Db, at: number, type: string, opts: { sessionHash?: string; sub?: string; detail?: Record<string, unknown> } = {}): void {
  db.prepare(`INSERT INTO auth_events (at, type, session_ref, sub, detail) VALUES (?, ?, ?, ?, ?)`).run(
    at,
    type,
    opts.sessionHash ? opts.sessionHash.slice(0, 12) : null,
    opts.sub ?? null,
    opts.detail ? JSON.stringify(opts.detail) : null,
  );
}

export type Db = DatabaseSync;

export const MIGRATION_COUNT = MIGRATIONS.length;

/** `upTo` (tests only): stop after that many migrations, to build a database as an older Store left it. */
export function openDatabase(dataDir: string, opts: { upTo?: number } = {}): Db {
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
  while (version < (opts.upTo ?? MIGRATIONS.length)) {
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
