// @vitest-environment node
/**
 * Upgrading the production database. The fixture is the schema the deployed server (835ac1a) created — migrations 1-7,
 * dumped from that commit's own openDatabase — with representative rows in every table, including Ship to Store
 * records and a hash-chained publishing audit. This build must upgrade it in place (migrations 8 and 9) losing nothing.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATION_COUNT } from "../src/db";
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
    expect(MIGRATION_COUNT).toBe(9);
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
});
