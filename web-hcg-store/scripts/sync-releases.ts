/**
 * Generates the HCG Store-approved releases in catalogue/releases.json (and approvers' "make current" choices in
 * catalogue/products.json) from the release records of an HCG Store server. See server/src/release-sync.ts.
 *
 *   npm run releases:sync -- --production        read the deployed server's records through `fly ssh console`
 *   npm run releases:sync -- --data-dir <dir>    read a local server's database (read-only)
 *   npm run releases:sync -- --from <file.json>  read a saved export (`node server-dist/release-records.mjs`)
 *   add --check                                  change nothing; exit 1 if the catalogue is out of date
 *
 * The result is validated like any catalogue change before anything is written.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateCatalogue } from "../src/domain/catalogue";
import type { Release } from "../src/domain/schema";
import { exportReleaseRecords, type ReleaseRecordsExport } from "../server/src/release-records";
import { syncReleases } from "../server/src/release-sync";

const root = resolve(import.meta.dirname, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");

function load(): ReleaseRecordsExport {
  const from = arg("--from");
  if (from) return JSON.parse(readFileSync(from, "utf8")) as ReleaseRecordsExport;
  const dataDir = arg("--data-dir");
  if (dataDir) {
    const db = new DatabaseSync(join(dataDir, "hcg-store.sqlite"), { readOnly: true });
    try {
      return exportReleaseRecords(db, Date.now());
    } finally {
      db.close();
    }
  }
  if (process.argv.includes("--production")) {
    const app = /^app\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "fly.toml"), "utf8"))?.[1];
    if (!app) throw new Error("fly.toml has no app name.");
    const r = spawnSync("fly", ["ssh", "console", "--app", app, "--command", "node --no-warnings server-dist/release-records.mjs"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fly ssh console failed (${r.status}): ${(r.stderr || r.error?.message || "").trim().slice(0, 400)}`);
    const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error("The server printed no release records.");
    return JSON.parse(line) as ReleaseRecordsExport;
  }
  throw new Error("Say where the records come from: --production, --data-dir <dir> or --from <file>.");
}

const productsPath = join(root, "catalogue/products.json");
const releasesPath = join(root, "catalogue/releases.json");
const productsDoc = JSON.parse(readFileSync(productsPath, "utf8")) as {
  products: { id: string; registry: { centralId: string | null }; editions?: { id: string }[]; currentReleaseId?: string | null }[];
};
const releasesDoc = JSON.parse(readFileSync(releasesPath, "utf8")) as { releases: Release[] };

const result = syncReleases(
  releasesDoc.releases,
  productsDoc.products.map((p) => ({ id: p.id, centralId: p.registry.centralId, editionIds: (p.editions ?? []).map((e) => e.id), currentReleaseId: p.currentReleaseId ?? null })),
  load(),
);
for (const s of result.skipped) console.warn(`skipped: ${s}`);
for (const n of result.notes) console.log(n);

const nextReleases = { ...releasesDoc, releases: result.releases };
const nextProducts = {
  ...productsDoc,
  products: productsDoc.products.map((p) => (p.id in result.currentReleaseIds ? { ...p, currentReleaseId: result.currentReleaseIds[p.id] } : p)),
};
const valid = validateCatalogue(nextProducts, nextReleases);
if (!valid.ok) {
  console.error("The generated catalogue does not validate; nothing was written:");
  for (const e of valid.errors) console.error(`  ${e}`);
  process.exit(1);
}
const outReleases = JSON.stringify(nextReleases, null, 2) + "\n";
const outProducts = JSON.stringify(nextProducts, null, 2) + "\n";
const changed = outReleases !== readFileSync(releasesPath, "utf8") || outProducts !== readFileSync(productsPath, "utf8");
const generated = result.releases.filter((r) => r.source?.kind === "hcg-store-approval").length;
if (check) {
  console.log(changed ? "catalogue/releases.json is out of date with HCG Store's approvals." : `Up to date (${generated} generated release(s)).`);
  process.exit(changed ? 1 : 0);
}
if (changed) {
  writeFileSync(releasesPath, outReleases);
  writeFileSync(productsPath, outProducts);
}
console.log(changed ? `Wrote ${generated} generated release(s). Commit catalogue/*.json; the approval in HCG Store was the review.` : `No change (${generated} generated release(s)).`);
