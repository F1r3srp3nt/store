/**
 * Consistent copies of the Store database (`VACUUM INTO`), kept on the data volume next to the live database. Fly.io
 * snapshots the whole volume daily; a snapshot taken while SQLite is writing may hold a half-written WAL, but these
 * copies are always complete. Off-host copies are a separate step (docs/PRODUCTION-DEPLOY.md, Backups).
 *
 * The copies hold what the database holds: account IDs, e-mail addresses, sealed (encrypted) HCG tokens, purchases and
 * the publishing audit. They are written with mode 0600 and never leave the volume unless the founder copies them.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";

const NAME = /^hcg-store-(\d{8}T\d{6}Z)\.sqlite$/;

export function backupDatabase(db: Db, dir: string, keep: number, now: number): { file: string; removed: string[] } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const file = join(dir, `hcg-store-${stamp}.sqlite`);
  // The path is built from a timestamp and a configured directory; quote it for SQL all the same.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  chmodSync(file, 0o600);
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) rmSync(join(dir, f));
  return { file, removed };
}
