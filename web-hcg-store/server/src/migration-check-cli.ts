/**
 * node migration-check.mjs --live /data/hcg-store.sqlite   (consistent read-only copy of the live database)
 * node migration-check.mjs --backup <file.sqlite>          (a backup file)
 * node migration-check.mjs --copy-to <file.sqlite> --live <file>   (only a consistent backup copy, read-only source)
 * With --if-exists, a missing source is reported as ok (a first deployment has no database yet).
 * Prints one JSON line with counts and check results only (migration-check.ts). Never writes the source.
 */
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkMigration } from "./migration-check";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
try {
  const live = arg("--live");
  const backup = arg("--backup");
  if (!live === !backup) throw new Error("Give exactly one of --live <file> or --backup <file>.");
  const source = (live ?? backup)!;
  const copyTo = arg("--copy-to");
  if (!existsSync(source) && process.argv.includes("--if-exists")) {
    process.stdout.write(JSON.stringify({ ok: true, note: "no database yet" }) + "\n");
    process.exit(0);
  }
  if (copyTo) {
    if (!live) throw new Error("--copy-to needs --live.");
    if (existsSync(copyTo)) throw new Error("The backup file already exists.");
    const db = new DatabaseSync(live, { readOnly: true });
    try { db.exec(`VACUUM INTO '${copyTo.replaceAll("'", "''")}'`); } finally { db.close(); }
    chmodSync(copyTo, 0o600);
    process.stdout.write(JSON.stringify({ ok: true, backup: copyTo }) + "\n");
    process.exit(0);
  }
  const r = checkMigration(live ? { live } : { backup: backup! });
  process.stdout.write(JSON.stringify(r) + "\n");
  if (!r.ok) process.exitCode = 1;
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n");
  process.exitCode = 1;
}
