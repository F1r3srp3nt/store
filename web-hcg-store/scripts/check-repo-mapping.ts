/**
 * Checks that HCG Store and HCG Repo link to each other consistently, in both directions:
 *   Store product/edition → HCG Repo product page (catalogue `hcgRepo`)
 *   HCG Repo product      → HCG Store product page and edition (Repo `config/products.toml`)
 * and that both sides name the same Debian package identifiers.
 *
 *   npm run check:repo-mapping -- ../path/to/HCG-repo
 *
 * Reads only local files. Exit code 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCatalogue } from "../src/domain/catalogue";

const root = resolve(import.meta.dirname, "..");
const repoDir = resolve(process.argv[2] ?? process.env.HCG_REPO_DIR ?? "");
if (!process.argv[2] && !process.env.HCG_REPO_DIR) {
  console.error("Usage: npm run check:repo-mapping -- <path to an HCG-repo checkout>");
  process.exit(2);
}

/** Minimal reader for the [[products]] tables and [store] base_url of HCG Repo's TOML files. */
export function readRepoProducts(toml: string) {
  const products: Record<string, string | string[]>[] = [];
  let current: Record<string, string | string[]> | null = null;
  let multiline = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (multiline) {
      if (line.endsWith('"""')) multiline = false;
      continue;
    }
    if (line === "[[products]]") {
      current = {};
      products.push(current);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current || !line || line.startsWith("#")) continue;
    const m = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    if (value.startsWith('"""')) {
      multiline = !value.slice(3).endsWith('"""');
      continue;
    }
    if (value.startsWith("[")) current[key] = [...value.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
    else if (value.startsWith('"')) current[key] = JSON.parse(value.replace(/\s+#.*$/, "")) as string;
  }
  return products;
}

const errors: string[] = [];
const result = validateCatalogue(
  JSON.parse(readFileSync(join(root, "catalogue/products.json"), "utf8")),
  JSON.parse(readFileSync(join(root, "catalogue/releases.json"), "utf8")),
);
if (!result.ok) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}
const store = result.catalogue.products;
const repoProducts = readRepoProducts(readFileSync(join(repoDir, "config/products.toml"), "utf8"));
const repoToml = readFileSync(join(repoDir, "config/repo.toml"), "utf8");
const storeBase = /\[store\][\s\S]*?base_url\s*=\s*"([^"]+)"/.exec(repoToml)?.[1];
const repoProduction = /\[urls\][\s\S]*?production\s*=\s*"([^"]+)"/.exec(repoToml)?.[1];

if (storeBase !== "https://store.hakmicapitalgroup.com/") errors.push(`HCG Repo [store] base_url is "${storeBase}", expected https://store.hakmicapitalgroup.com/.`);
if (repoProduction !== "https://repo.hakmicapitalgroup.com/") errors.push(`HCG Repo production URL is "${repoProduction}", expected https://repo.hakmicapitalgroup.com/.`);

const repoByKey = new Map(repoProducts.map((p) => [p.key as string, p]));
const lines: string[] = [];

// Store → Repo
for (const p of store) {
  for (const link of p.hcgRepo) {
    const r = repoByKey.get(link.key);
    const edition = link.editionId ? p.editions.find((e) => e.id === link.editionId) : null;
    if (!r) {
      errors.push(`Store "${p.slug}"${link.editionId ? ` edition "${link.editionId}"` : ""} links to HCG Repo product "${link.key}", which HCG Repo does not define.`);
      continue;
    }
    if (r.store_slug !== p.slug) errors.push(`HCG Repo "${link.key}" points back to Store "${String(r.store_slug)}", not "${p.slug}".`);
    if ((r.store_edition ?? null) !== (link.editionId ?? null)) {
      errors.push(`HCG Repo "${link.key}" names edition "${String(r.store_edition ?? "none")}", Store maps edition "${link.editionId ?? "none"}".`);
    }
    const storePkgs = (edition?.identifiers ?? []).filter((i) => i.kind === "debian-package").map((i) => i.value).sort();
    const repoPkgs = [...((r.package_ids as string[]) ?? [])].sort();
    if (JSON.stringify(storePkgs) !== JSON.stringify(repoPkgs)) {
      errors.push(`Package IDs differ for "${link.key}": Store ${JSON.stringify(storePkgs)}, HCG Repo ${JSON.stringify(repoPkgs)}.`);
    }
    if (r.access === "public") errors.push(`HCG Repo "${link.key}" is public, but HCG Store requires sign-in for every product.`);
    lines.push(
      `  Store /apps/${p.slug}${link.editionId ? `?edition=${link.editionId}` : ""}  ⇄  Repo /products/${link.key}/  ${repoPkgs.length ? repoPkgs.join(", ") : "(no package)"}`,
    );
  }
}

// Repo → Store
for (const r of repoProducts) {
  const p = store.find((x) => x.slug === r.store_slug);
  if (!p) {
    errors.push(`HCG Repo "${String(r.key)}" points to Store product "${String(r.store_slug)}", which the Store catalogue does not define.`);
    continue;
  }
  if (!p.hcgRepo.some((l) => l.key === r.key)) errors.push(`Store "${p.slug}" has no link back to HCG Repo product "${String(r.key)}".`);
}

if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  process.exit(1);
}
console.log(`✔ HCG Store ⇄ HCG Repo mapping consistent (${repoProducts.length} HCG Repo products, ${lines.length} Store links):`);
for (const l of lines) console.log(l);
