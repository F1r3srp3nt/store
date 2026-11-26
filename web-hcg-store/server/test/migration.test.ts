// @vitest-environment node
/**
 * Upgrading the production database. The fixture is the schema the deployed server (835ac1a) created — migrations 1-7,
 * dumped from that commit's own openDatabase — with representative rows in every table, including Ship to Store
 * records and a hash-chained publishing audit. This build must upgrade it in place (migrations 8 and 9) losing nothing.
 */
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATION_COUNT, openDatabase } from "../src/db";
import { checkMigration } from "../src/migration-check";

function productionBackup(): string {
  const file = join(mkdtempSync(join(tmpdir(), "hcg-v7-")), "backup.sqlite");
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(__dirname, "fixtures", "production-schema-v7.sql"), "utf8"));
  db.close();
  return file;
}

describe("migration from the deployed schema (v7)", () => {
  it("upgrades a backup copy to the latest schema without losing a row, breaking the audit chain or publishing anything", () => {
    const backup = productionBackup();
    const r = checkMigration({ backup });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, versionBefore: 7, versionAfter: MIGRATION_COUNT, integrity: "ok", foreignKeyProblems: 0, publishingAuditIntact: true });
    expect(MIGRATION_COUNT).toBe(10);   // 10: Distribution Studio (release publication requests, draft product fields)
    expect(r.tables.sessions).toEqual({ before: 3, after: 3 });
    expect(r.tables.pub_audit).toEqual({ before: 3, after: 3 });
    expect(r.tables.free_windows).toEqual({ before: null, after: 0 });
    expect(r.tables.release_exceptions).toEqual({ before: null, after: 0 });
    // The source backup itself is untouched.
    const src = new DatabaseSync(backup, { readOnly: true });
    expect((src.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(7);
    src.close();
  });

  it("works on a live database file without writing it", () => {
    const live = productionBackup();
    const r = checkMigration({ live });
    expect(r.ok).toBe(true);
    const src = new DatabaseSync(live, { readOnly: true });
    expect((src.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(7);
    src.close();
  });

  it("passes again on a database already at the latest schema that holds published, imported and free-window records", () => {
    // What the NEXT deploy's dry run sees after the first publication: the upgraded database with real activity.
    const backup = productionBackup();
    const first = new DatabaseSync(backup);
    first.close();
    const dir = mkdtempSync(join(tmpdir(), "hcg-v9-"));
    const db = new DatabaseSync(join(dir, "src.sqlite"));
    db.exec(readFileSync(join(__dirname, "fixtures", "production-schema-v7.sql"), "utf8"));
    db.close();
    // Upgrade it once (as the deploy would), then add activity the new code creates.
    const upgradedDir = mkdtempSync(join(tmpdir(), "hcg-v9-live-"));
    copyFileSync(join(dir, "src.sqlite"), join(upgradedDir, "hcg-store.sqlite"));
    const live = openDatabase(upgradedDir);
    const T = 1_765_000_000_000;
    live.prepare("UPDATE pub_releases SET status = 'published', published_at = ?, imported_from = '{\"repository\":\"x/y\"}' WHERE id = 'rel-0000000000000002'").run(T);
    live.prepare("INSERT INTO free_windows (id, product_id, edition_id, release_id, starts_at, ends_at, anchor, duration_ms, created_at) VALUES ('fw-1', 'hcg-mail', 'windows-desktop', 'rel-0000000000000002', ?, ?, 'publication', 1, ?)").run(T, T + 1, T);
    live.prepare("INSERT INTO free_window_events (at, window_id, action, detail, authorised_by, performed_by) VALUES (?, 'fw-1', 'window.prepared', '{}', 'a', 'b')").run(T);
    live.prepare("INSERT INTO release_exceptions (id, release_id, kind, subject, artifact_digest, reason, authorised_by, performed_by, created_at) VALUES ('rx-1', 'rel-0000000000000002', 'founder-operated', 's', 'd', 'r', 'a', 'b', ?)").run(T);
    live.close();
    const r = checkMigration({ live: join(upgradedDir, "hcg-store.sqlite") });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, versionBefore: MIGRATION_COUNT, versionAfter: MIGRATION_COUNT });
    expect(r.tables.free_windows).toEqual({ before: 1, after: 1 });
  });
});
