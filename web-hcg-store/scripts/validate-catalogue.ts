/**
 * Validates the catalogue files: schema, unique IDs, cross-references, editions, HCG Repo links,
 * the absence of download URLs, and media files.
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
    for (const [slot, art] of [["icon", p.artwork.icon], ["cover", p.artwork.cover]] as const) {
      if (!art || p.id.startsWith("fixture-")) continue;
      const where = `products["${p.id}"].artwork.${slot}`;
      const files = [{ src: art.src, width: art.width }, ...art.variants];
      for (const f of files) {
        for (const src of art.avif ? [f.src, f.src.replace(/\.webp$/, ".avif")] : [f.src]) {
          const path = join(root, "public", src);
          if (!existsSync(path)) {
            errors.push(`${where}: file public/${src} does not exist.`);
            continue;
          }
          // Declared sizes are what the page reserves (no layout shift), so they must match the file.
          const size = src.endsWith(".webp") ? webpSize(readFileSync(path)) : null;
          const expectedHeight = Math.round((f.width * art.height) / art.width);
          if (size && (size.width !== f.width || Math.abs(size.height - expectedHeight) > 1)) {
            errors.push(`${where}: public/${src} is ${size.width}×${size.height}, catalogue says ${f.width}×${expectedHeight}.`);
          }
        }
      }
    }
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

/** Width and height of a WebP file (VP8, VP8L or VP8X), or null if the header is not recognised. */
function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}
