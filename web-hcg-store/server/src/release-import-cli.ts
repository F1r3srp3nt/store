/**
 * Operator command: import a release a product's CI built (publishing.ts `importRelease`). Runs on the server, never
 * over HTTP. The import folder holds the files exactly as downloaded from the CI run (files/) and the run's HCG Store
 * draft with its Release Passports (draft/store-release-draft.json, draft/passports/<file>.passport.json).
 *
 *   node server-dist/release-import.mjs --dir <folder> --request <release-imports/....json>
 *        --authorised-by-b64 <b64> --performed-by-b64 <b64>
 *
 * Result: a private DRAFT, waiting for a person to submit it, approve it and, separately, publish it in HCG Store.
 * Prints one JSON line. Never prints a token, a file path outside the import or an account ID.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseStoreConfig } from "./config";
import { openDatabase } from "./db";
import { NoAuthority } from "./entitlements";
import { HttpError } from "./http";
import { createPublishing } from "./publishing";
import { loadRegistry } from "./registry";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const b64 = (name: string) => Buffer.from(arg(name) ?? "", "base64").toString("utf8");

export const ImportRequestSchema = z.object({
  format: z.literal("hcg.store.release-import/1"),
  source: z.object({ repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/), commit: z.string().regex(/^[a-f0-9]{40}$/), runId: z.number().int().positive() }).passthrough(),
  expect: z.object({ productId: z.string(), editionId: z.string().nullable(), version: z.string(), build: z.string(), channel: z.string(), distribution: z.string(), files: z.number().int().positive() }),
  requestedEligibility: z.enum(["private", "internal-testing", "public"]),
  knownLimitations: z.array(z.string().min(1).max(500)).max(30).default([]),
}).passthrough();

async function main() {
  const cfg = parseStoreConfig(process.env);
  const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: cfg.mode === "test" });
  const db = openDatabase(cfg.dataDir);
  try {
    const dir = arg("--dir") ?? "";
    const request = ImportRequestSchema.parse(JSON.parse(readFileSync(arg("--request") ?? "", "utf8")));
    const draft = JSON.parse(readFileSync(join(dir, "draft", "store-release-draft.json"), "utf8")) as { release: Record<string, unknown>; artifacts: unknown[] };
    for (const [k, v] of Object.entries(request.expect)) {
      if (k === "files") continue;
      if (String(draft.release[k] ?? null) !== String(v)) throw new HttpError(400, "request_mismatch", `The draft's ${k} is ${String(draft.release[k])}, the request says ${String(v)}.`);
    }
    if (draft.artifacts.length !== request.expect.files) throw new HttpError(400, "request_mismatch", `The draft lists ${draft.artifacts.length} files, the request expects ${request.expect.files}.`);
    const passports: Record<string, never> = {};
    for (const f of readdirSync(join(dir, "draft", "passports"))) {
      const p = JSON.parse(readFileSync(join(dir, "draft", "passports", f), "utf8"));
      (passports as Record<string, unknown>)[p.artifact.filename] = p;
    }
    const publishing = createPublishing({
      cfg, db, registry, connect: null, authority: new NoAuthority(), now: () => Date.now(),
      freshSession: async () => ({ session: null, unavailable: false }),
      streamArtifact: () => undefined,
    });
    const r = await publishing.importRelease({
      draft, filesDir: join(dir, "files"), passports,
      source: { repository: request.source.repository, commit: request.source.commit, runId: request.source.runId },
      requestedEligibility: request.requestedEligibility, knownLimitations: request.knownLimitations,
      authorisedBy: b64("--authorised-by-b64"), performedBy: b64("--performed-by-b64"),
    });
    process.stdout.write(JSON.stringify({
      imported: true, releaseId: r.id, status: r.status, stage: r.stage, productId: r.productId, editionId: r.editionId, version: r.version, build: r.build,
      requestedEligibility: r.requestedEligibility, distribution: r.distribution,
      files: r.artifacts.map((a) => ({ fileName: a.fileName, status: a.status, sizeBytes: a.sizeBytes, sha256: a.sha256, kind: a.kind, readiness: a.readiness.label })),
      reviewUrl: r.reviewUrl,
    }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ imported: false, error: e instanceof HttpError ? e.message : e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message }) + "\n");
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
void main();
