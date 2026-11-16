import type { z } from "zod";
import { ProductsDocumentSchema, ReleasesDocumentSchema, type Artifact, type Product, type Release } from "./schema";
import { compareSemver } from "./version";

export interface Catalogue {
  products: Product[];
  releases: Release[];
}

export type ValidationResult =
  | { ok: true; catalogue: Catalogue; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function formatIssues(prefix: string, error: z.ZodError, doc: unknown): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String);
    // Name the offending record (e.g. products[3] "hcg-mail") instead of only its index.
    let label = `${prefix}.${path.join(".")}`;
    if (path.length >= 2 && doc && typeof doc === "object") {
      const list = (doc as Record<string, unknown>)[path[0]!];
      const rec = Array.isArray(list) ? list[Number(path[1])] : undefined;
      const id = rec && typeof rec === "object" ? (rec as { id?: unknown }).id : undefined;
      if (typeof id === "string") label = `${prefix}.${path[0]}["${id}"].${path.slice(2).join(".")}`;
    }
    return `${label.replace(/\.$/, "")}: ${issue.message}`;
  });
}

/** Validates both catalogue documents and all cross-references. Pure: safe in Node and the browser. */
export function validateCatalogue(productsDoc: unknown, releasesDoc: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const p = ProductsDocumentSchema.safeParse(productsDoc);
  const r = ReleasesDocumentSchema.safeParse(releasesDoc);
  if (!p.success) errors.push(...formatIssues("products.json", p.error, productsDoc));
  if (!r.success) errors.push(...formatIssues("releases.json", r.error, releasesDoc));
  if (!p.success || !r.success) return { ok: false, errors, warnings };

  const products = p.data.products;
  const releases = r.data.releases;

  const dupes = (values: string[], what: string) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) errors.push(`Duplicate ${what}: "${v}".`);
      seen.add(v);
    }
  };
  dupes(products.map((x) => x.id), "product id");
  dupes(products.map((x) => x.slug), "product slug");
  dupes(products.map((x) => x.name.toLowerCase()), "product name");
  dupes(releases.map((x) => x.id), "release id");
  dupes(
    products.flatMap((x) => (x.registry.centralId ? [x.registry.centralId] : [])),
    "central registry id",
  );

  const byId = new Map(products.map((x) => [x.id, x]));
  const releaseById = new Map(releases.map((x) => [x.id, x]));

  for (const rel of releases) {
    const product = byId.get(rel.productId);
    if (!product) errors.push(`Release "${rel.id}" references unknown product "${rel.productId}".`);
    dupes(rel.artifacts.map((a) => a.id), `artifact id in release "${rel.id}"`);
    for (const a of rel.artifacts) {
      checkArtifactWarnings(rel, a, warnings);
      if (product && a.editionId && !product.editions.some((e) => e.id === a.editionId))
        errors.push(`Release "${rel.id}" artifact "${a.id}" references unknown edition "${a.editionId}" of "${product.id}".`);
      if (product && product.editions.length > 1 && !a.editionId)
        errors.push(`Release "${rel.id}" artifact "${a.id}" must name its edition: "${product.id}" has several editions.`);
    }
  }

  dupes(
    products.flatMap((x) => x.hcgRepo.map((l) => l.key)),
    "HCG Repo product key",
  );
  dupes(
    products.flatMap((x) => x.editions.flatMap((e) => e.identifiers.filter((i) => i.kind !== "bundle-id").map((i) => `${i.kind}:${i.value}`))),
    "edition package identifier",
  );

  for (const product of products) {
    const versions = releases.filter((x) => x.productId === product.id).map((x) => x.version);
    // Two releases with the same version precedence would make history ambiguous.
    for (let i = 0; i < versions.length; i++)
      for (let j = i + 1; j < versions.length; j++)
        if (compareSemver(versions[i]!, versions[j]!) === 0)
          errors.push(`Product "${product.id}" has two releases with version ${versions[i]}.`);

    if (product.currentReleaseId) {
      const cur = releaseById.get(product.currentReleaseId);
      if (!cur) errors.push(`Product "${product.id}" currentReleaseId "${product.currentReleaseId}" does not exist.`);
      else if (cur.productId !== product.id)
        errors.push(`Product "${product.id}" currentReleaseId points to a release of "${cur.productId}".`);
      else if (cur.status !== "approved")
        errors.push(`Product "${product.id}" currentReleaseId points to withdrawn release "${cur.id}".`);
    }
    dupes(product.editions.map((e) => e.id), `edition id in product "${product.id}"`);
    for (const link of product.hcgRepo) {
      if (link.editionId && !product.editions.some((e) => e.id === link.editionId))
        errors.push(`Product "${product.id}" HCG Repo link "${link.key}" references unknown edition "${link.editionId}".`);
    }
    for (const e of product.editions) {
      if (e.channel === "jailbreak-package" && !e.identifiers.some((i) => i.kind === "debian-package"))
        errors.push(`Product "${product.id}" edition "${e.id}" is a jailbreak package but declares no package identifier.`);
    }
    if (product.supersededBy) {
      const successor = byId.get(product.supersededBy);
      if (!successor) errors.push(`Product "${product.id}" is superseded by unknown product "${product.supersededBy}".`);
      else if (successor.supersededBy) errors.push(`Product "${product.id}" is superseded by "${successor.id}", which is itself superseded.`);
      if (product.collections.length) errors.push(`Superseded product "${product.id}" must not be in storefront collections.`);
    }
    if (product.registry.status === "central" && !product.registry.centralId) {
      errors.push(`Product "${product.id}" is marked central but has no centralId.`);
    }
    const editionKeys = product.editions.flatMap((e) => (e.centralEditionKey ? [e.centralEditionKey] : []));
    if (editionKeys.length && !product.registry.centralId) {
      errors.push(`Product "${product.id}" maps editions to central keys but has no central product ID.`);
    }
    if (new Set(editionKeys).size !== editionKeys.length) {
      errors.push(`Product "${product.id}" maps two editions to the same central edition key.`);
    }
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, catalogue: { products, releases }, warnings };
}

function checkArtifactWarnings(rel: Release, a: Artifact, warnings: string[]) {
  const where = `Release "${rel.id}" artifact "${a.id}"`;
  if (!a.sha256) warnings.push(`${where}: no SHA-256 checksum published.`);
  if (!a.sizeBytes) warnings.push(`${where}: file size not stated.`);
}
