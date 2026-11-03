/**
 * Validates the catalogue files: schema, unique IDs, cross-references, Dropbox links and media files.
 *
 *   npm run validate:catalogue                    # catalogue/
 *   npm run validate:catalogue -- path/to/dir     # another directory (e.g. the test fixture)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCatalogue } from "../src/domain/catalogue";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, process.argv[2] ?? process.env.HCG_CATALOGUE_DIR ?? "catalogue");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;

let products: unknown, releases: unknown;
try {
  products = read("products.json");
  releases = read("releases.json");
} catch (e) {
  console.error(`✖ Could not read catalogue JSON in ${dir}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const result = validateCatalogue(products, releases);
const errors = result.ok ? [] : [...result.errors];

if (result.ok) {
  for (const p of result.catalogue.products) {
    for (const m of p.media) {
      for (const src of [m.src, ...m.variants.map((v) => v.src)]) {
        if (!existsSync(join(root, "public", src)) && !p.id.startsWith("fixture-")) {
          errors.push(`products["${p.id}"].media: file public/${src} does not exist.`);
        }
      }
    }
  }
}

for (const w of result.warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(`\nCatalogue INVALID (${errors.length} error${errors.length === 1 ? "" : "s"}) — ${dir}`);
  process.exit(1);
}
if (result.ok) {
  const { products: ps, releases: rs } = result.catalogue;
  const current = ps.filter((p) => p.currentReleaseId).length;
  console.log(`✔ Catalogue valid — ${dir}`);
  console.log(`  ${ps.length} products, ${rs.length} releases, ${current} products with a current approved release.`);
}
