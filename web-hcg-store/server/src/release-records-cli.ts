/**
 * Prints the release records approved in HCG Store as JSON (see release-records.ts):
 * `node server-dist/release-records.mjs` (on Fly.io, through `fly ssh console`). Opens the database read-only.
 * `npm run releases:sync` turns the output into catalogue/releases.json.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportReleaseRecords } from "./release-records";

const dataDir = process.env.HCG_STORE_DATA_DIR ?? "data";
const db = new DatabaseSync(join(dataDir, "hcg-store.sqlite"), { readOnly: true });
process.stdout.write(JSON.stringify(exportReleaseRecords(db, Date.now())) + "\n");
db.close();
