/**
 * Migration dry run: upgrades a COPY of a Store database with this build's migrations and checks that nothing was
 * lost or broken. The live database is never written: a consistent copy is taken with VACUUM INTO (or an existing
 * backup file is copied) into a temporary folder, upgraded there, checked, and deleted.
 *
 * Reports only counts, versions and check results: no account IDs, e-mail addresses, tokens or other row contents.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATION_COUNT, openDatabase } from "./db";
import { auditChainIntact } from "./release-records";

export interface MigrationCheck {
  ok: boolean;
  versionBefore: number;
  versionAfter: number;
  latestVersion: number;
  integrity: string;
  foreignKeyProblems: number;
  publishingAuditIntact: boolean;
  tables: Record<string, { before: number | null; after: number }>;
  problems: string[];
}

const counts = (db: DatabaseSync) => {
  const out: Record<string, number> = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    out[name] = (db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n;
  }
  return out;
};

/** `source`: a live database file (copied consistently with VACUUM INTO, read-only) or a backup file (copied). */
export function checkMigration(source: { live: string } | { backup: string }): MigrationCheck {
  const work = mkdtempSync(join(tmpdir(), "hcg-store-migration-check-"));
  try {
    const dir = join(work, "data");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const copy = join(dir, "hcg-store.sqlite");
    if ("live" in source) {
      const live = new DatabaseSync(source.live, { readOnly: true });
      try { live.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { live.close(); }
    } else {
      copyFileSync(source.backup, copy);
    }
    const before = new DatabaseSync(copy, { readOnly: true });
    const versionBefore = (before.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)?.version ?? 0;
    const countsBefore = counts(before);
    const publishedQuery = "SELECT count(*) AS n FROM pub_releases WHERE status = 'published' OR published_at IS NOT NULL";
    let publishedBefore = 0;
    try { publishedBefore = (before.prepare(publishedQuery).get() as { n: number }).n; } catch { /* published_at arrives with migration 8 */
      publishedBefore = countsBefore.pub_releases === undefined ? 0 : (before.prepare("SELECT count(*) AS n FROM pub_releases WHERE status = 'published'").get() as { n: number }).n;
    }
    let importedBefore = 0;
    try { importedBefore = (before.prepare("SELECT count(*) AS n FROM pub_releases WHERE imported_from IS NOT NULL").get() as { n: number }).n; } catch { /* column arrives with migration 9 */ }
    before.close();

    const db = openDatabase(dir); // applies this build's migrations to the copy
    const problems: string[] = [];
    const versionAfter = (db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
    const countsAfter = counts(db);
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
    const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all().length;
    const publishingAuditIntact = auditChainIntact(db);
    for (const [t, n] of Object.entries(countsBefore)) {
      if (t === "schema_version") continue;
      if (countsAfter[t] === undefined) problems.push(`table ${t} is gone`);
      else if (countsAfter[t] !== n) problems.push(`table ${t}: ${n} rows before, ${countsAfter[t]} after`);
    }
    if (versionAfter !== MIGRATION_COUNT) problems.push(`schema version ${versionAfter}, expected ${MIGRATION_COUNT}`);
    if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
    if (foreignKeyProblems) problems.push(`${foreignKeyProblems} foreign key problems`);
    if (!publishingAuditIntact) problems.push("the publishing audit chain does not verify");
    // Every stored JSON column the new code reads still parses, and the new columns have their defaults.
    for (const r of db.prepare("SELECT id, release_notes, compatibility, destinations, known_limitations, imported_from FROM pub_releases").all() as Record<string, string | null>[]) {
      for (const k of ["release_notes", "compatibility", "destinations", "known_limitations"]) {
        try { JSON.parse(r[k] ?? ""); } catch { problems.push(`release ${r.id}: ${k} is not JSON`); }
      }
    }
    const importedAfter = (db.prepare("SELECT count(*) AS n FROM pub_releases WHERE imported_from IS NOT NULL").get() as { n: number }).n;
    if (importedAfter !== importedBefore) problems.push(`the upgrade changed which releases are marked imported (${importedBefore} → ${importedAfter})`);
    for (const r of db.prepare("SELECT id, architectures, signing_reported, provenance FROM pub_artifacts").all() as Record<string, string | null>[]) {
      for (const k of ["architectures", "signing_reported"]) {
        try { JSON.parse(r[k] ?? ""); } catch { problems.push(`artifact ${r.id}: ${k} is not JSON`); }
      }
    }
    // Nothing becomes published, free or excepted by the upgrade itself (existing records are kept as they were).
    const publishedAfter = (db.prepare(publishedQuery).get() as { n: number }).n;
    if (publishedAfter !== publishedBefore) problems.push(`published releases: ${publishedBefore} before the upgrade, ${publishedAfter} after`);
    for (const t of ["free_windows", "free_window_events", "release_exceptions"]) {
      if (countsBefore[t] === undefined && countsAfter[t]) problems.push(`the upgrade created rows in ${t}`);
    }
    db.close();
    const tables: MigrationCheck["tables"] = {};
    for (const [t, n] of Object.entries(countsAfter)) tables[t] = { before: countsBefore[t] ?? null, after: n };
    return { ok: problems.length === 0, versionBefore, versionAfter, latestVersion: MIGRATION_COUNT, integrity, foreignKeyProblems, publishingAuditIntact, tables, problems };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
