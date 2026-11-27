/**
 * The committed import request (web-hcg-store/release-imports/*.json) for an operator import, and the release draft
 * it stands for. A CI-run import carries its draft and Release Passports in the import folder; a GitHub-release import
 * (files a person built and attached to a GitHub release) has neither, so the request itself declares the release
 * record and files, and every file is a manual upload with no build evidence claimed.
 */
import { z } from "zod";
import { HttpError } from "./http";

const repository = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
export const ImportRequestSchema = z.object({
  format: z.literal("hcg.store.release-import/1"),
  source: z.union([
    z.object({ kind: z.literal("ci-run").optional(), repository, commit: z.string().regex(/^[a-f0-9]{40}$/), runId: z.number().int().positive() }).passthrough(),
    // Files a person attached to a GitHub release: no CI run, no draft, no passports. The release record is declared in
    // this committed request (below) and reviewed like any other.
    z.object({
      kind: z.literal("github-release"), repository, tag: z.string().regex(/^[A-Za-z0-9._+-]{1,100}$/),
      tagCommit: z.string().regex(/^[a-f0-9]{40}$/), evidenceRun: z.number().int().positive().nullable().default(null),
    }).passthrough(),
  ]),
  /** github-release only: the release record and files, as verified by the evidence run (no draft exists). */
  release: z.object({
    releaseNotes: z.array(z.string()).default([]),
    compatibility: z.unknown().optional(),
    artifacts: z.array(z.record(z.string(), z.unknown())).min(1),
  }).optional(),
  expect: z.object({
    productId: z.string(), editionId: z.string().nullable(), version: z.string(), build: z.string(), channel: z.string(), distribution: z.string(),
    files: z.number().int().positive(),
    /** The exact SHA-256 of every file, committed with the request: any other bytes are refused. */
    sha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  }),
  requestedEligibility: z.enum(["private", "internal-testing", "public"]),
  knownLimitations: z.array(z.string().min(1).max(500)).max(30).default([]),
}).passthrough();

export type ImportRequest = z.infer<typeof ImportRequestSchema>;
export type ImportDraft = { release: Record<string, unknown>; artifacts: unknown[] };

/** The release draft a GitHub-release request declares (a CI-run import reads the run's own draft instead). */
export function draftFromRequest(request: ImportRequest): ImportDraft {
  if (request.source.kind !== "github-release") throw new HttpError(400, "request_mismatch", "Only a GitHub release import declares its own draft.");
  if (!request.release) throw new HttpError(400, "request_mismatch", "A GitHub release import must declare its release record and files.");
  return {
    release: {
      productId: request.expect.productId, editionId: request.expect.editionId, version: request.expect.version, build: request.expect.build,
      channel: request.expect.channel, distribution: request.expect.distribution, eligibility: "private", destinations: ["hcg-store"],
      releaseNotes: request.release.releaseNotes, ...(request.release.compatibility ? { compatibility: request.release.compatibility } : {}),
    },
    artifacts: request.release.artifacts,
  };
}
