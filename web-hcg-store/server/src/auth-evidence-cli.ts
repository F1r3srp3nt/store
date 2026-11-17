/**
 * Prints the sign-in evidence trail as JSON, for verifying a deployed server without access to its
 * tokens: `node server-dist/auth-evidence.mjs [--since <ms>]` (on Fly.io, through `fly ssh console`).
 *
 * Output: `{ events: [...], sessions: [...], publishing: {...} }`. Events come from `auth_events`; sessions carry only
 * a 12-character reference, timestamps, the end reason and whether each stored token column is empty. `publishing`
 * is the Ship to Store audit since the same time (actors shortened to 8 characters) and whether its hash chain verifies.
 * It never reads a token value, and opens the database without changing it.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditChainIntact } from "./release-records";

const dataDir = process.env.HCG_STORE_DATA_DIR ?? "data";
const i = process.argv.indexOf("--since");
const since = i > 0 ? Number(process.argv[i + 1]) || 0 : 0;
const db = new DatabaseSync(join(dataDir, "hcg-store.sqlite"), { readOnly: true });
const events = db.prepare("SELECT id, at, type, session_ref, sub, detail FROM auth_events WHERE at >= ? ORDER BY id").all(since);
const sessions = db
  .prepare(
    `SELECT substr(id_hash, 1, 12) AS session_ref, created_at, last_seen_at, ended_at, ended_reason,
            refresh_token IS NULL AS refresh_token_deleted, access_token IS NULL AS access_token_deleted
     FROM sessions WHERE created_at >= ? OR last_seen_at >= ? OR ended_at >= ?`,
  )
  .all(since, since, since);
const publishing = {
  auditIntact: auditChainIntact(db),
  entries: db
    .prepare("SELECT seq, at, substr(actor, 1, 8) AS actor_ref, action, release_id, artifact_id, detail FROM pub_audit WHERE at >= ? ORDER BY seq")
    .all(since),
};
process.stdout.write(JSON.stringify({ events, sessions, publishing }) + "\n");
db.close();
