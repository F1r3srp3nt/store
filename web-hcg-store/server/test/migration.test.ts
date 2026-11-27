// @vitest-environment node
/**
 * Upgrading the production database. The fixture is the schema the deployed server (835ac1a) created — migrations 1-7,
 * dumped from that commit's own openDatabase — with representative rows in every table, including Ship to Store
 * records and a hash-chained publishing audit. This build must upgrade it in place (migrations 8 to 11) losing nothing.
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
    expect(MIGRATION_COUNT).toBe(11);
    expect(r.tables.pub_current).toEqual({ before: null, after: 0 });
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

  it("migration 10 makes each target's newest published release current, per platform, architecture and channel, and keeps everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcg-v9-"));
    const v9 = openDatabase(dir, { upTo: 9 });
    const rel = (id: string, channel: string, status: string, publishedAt: number | null) =>
      v9.prepare(`INSERT INTO pub_releases (id, product_id, product_source, edition_id, version, build, channel, release_notes, compatibility, distribution, requested_eligibility, destinations, status, approved_eligibility, created_by, created_at, updated_at, published_at)
                  VALUES (?, 'p', 'catalogue', NULL, ?, '1', ?, '[]', '{}', 'free', 'public', '["hcg-store"]', ?, 'public', 'u', 1, 1, ?)`).run(id, `1.0.${id.charCodeAt(4) - 96}`, channel, status, publishedAt);
    const art = (id: string, releaseId: string, platform: string, format: string, archs: string[]) =>
      v9.prepare(`INSERT INTO pub_artifacts (id, release_id, file_name, platform, format, architectures, size_bytes, declared_sha256, sha256, status, storage_key, content_type, signing_reported, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 1, 'x', 'x', 'verified', ?, 'application/octet-stream', '{}', 1)`).run(id, releaseId, `${id}.${format}`, platform, format, JSON.stringify(archs), `k/${id}`);
    rel("rel-a", "stable", "published", 100); art("art-a1", "rel-a", "windows", "exe", ["x64"]); art("art-a2", "rel-a", "macos", "zip", ["arm64", "x64"]);
    rel("rel-b", "stable", "published", 200); art("art-b1", "rel-b", "windows", "exe", ["x64"]);
    rel("rel-c", "beta", "published", 300); art("art-c1", "rel-c", "windows", "exe", ["x64"]);
    rel("rel-d", "stable", "approved", null); art("art-d1", "rel-d", "linux", "appimage", []);
    rel("rel-e", "stable", "published", 400); art("art-e1", "rel-e", "android", "aab", []);
    v9.close();
    const db = openDatabase(dir);
    const cur = db.prepare("SELECT platform, arch, channel, release_id FROM pub_current ORDER BY platform, arch, channel").all();
    expect(cur).toEqual([
      { platform: "macos", arch: "arm64", channel: "stable", release_id: "rel-a" },
      { platform: "macos", arch: "x64", channel: "stable", release_id: "rel-a" },
      { platform: "windows", arch: "x64", channel: "beta", release_id: "rel-c" },
      { platform: "windows", arch: "x64", channel: "stable", release_id: "rel-b" },
    ]);
    const after = db.prepare("SELECT id, status, availability, revision FROM pub_releases ORDER BY id").all() as { id: string; status: string; availability: string; revision: number }[];
    expect(after.map((r) => [r.id, r.status, r.availability])).toEqual([["rel-a", "published", "available"], ["rel-b", "published", "available"], ["rel-c", "published", "available"], ["rel-d", "approved", "available"], ["rel-e", "published", "available"]]);
    // Revocation is final at the database level.
    db.prepare("UPDATE pub_releases SET availability = 'revoked' WHERE id = 'rel-d'").run();
    expect(() => db.prepare("UPDATE pub_releases SET availability = 'available' WHERE id = 'rel-d'").run()).toThrow(/stays revoked/);
    // Every change bumps the revision.
    const before = (db.prepare("SELECT revision FROM pub_releases WHERE id = 'rel-b'").get() as { revision: number }).revision;
    db.prepare("UPDATE pub_releases SET updated_at = 5 WHERE id = 'rel-b'").run();
    expect((db.prepare("SELECT revision FROM pub_releases WHERE id = 'rel-b'").get() as { revision: number }).revision).toBe(before + 1);
    db.close();
  });

  it("migration 11 (Distribution Studio) is additive: a database at 9 (production today) or at 10 upgrades without losing a row", () => {
    for (const from of [9, 10]) {
      const dir = mkdtempSync(join(tmpdir(), `hcg-v${from}-`));
      const before = openDatabase(dir, { upTo: from });
      before.prepare(`INSERT INTO pub_releases (id, product_id, product_source, edition_id, version, build, channel, release_notes, compatibility, distribution, requested_eligibility, destinations, status, created_by, created_at, updated_at)
                      VALUES ('rel-0000000000000001', 'p', 'catalogue', NULL, '1.0.0', '1', 'stable', '["n"]', '{}', 'paid', 'public', '["hcg-store"]', 'draft', 'u', 1, 1)`).run();
      before.prepare("INSERT INTO pub_products (id, title, created_by, created_at) VALUES ('d', 'Draft', 'u', 1)").run();
      before.close();
      const db = openDatabase(dir);
      expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(MIGRATION_COUNT);
      const r = db.prepare("SELECT status, release_notes, publication_request, availability FROM pub_releases").get() as Record<string, unknown>;
      expect(r).toEqual({ status: "draft", release_notes: '["n"]', publication_request: null, availability: "available" });
      expect((db.prepare("SELECT metadata FROM pub_products").get() as { metadata: string }).metadata).toBe("{}");
      db.close();
    }
  });
});

