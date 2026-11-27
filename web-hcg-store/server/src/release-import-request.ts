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
  /**
   * CI-run only: release notes reviewed for HCG Store, replacing the run's own (e.g. where the run calls a permanently
   * free edition "free during testing"). The files are never changed.
   */
  reviewedReleaseNotes: z.array(z.string().min(1).max(500)).min(1).max(50).optional(),
  /**
   * CI-run only: a file the run reports as Developer ID "signed" that HCG Store itself verified as notarized (stapled
   * ticket, Gatekeeper "Notarized Developer ID" on the quarantined download), with that verification as evidence.
   * Only "signed" can become "notarized"; nothing else is upgraded.
   */
  storeVerifiedSigning: z.record(z.string(), z.object({ status: z.literal("notarized"), evidence: z.string().min(20).max(1000) })).optional(),
  /**
   * CI-run only: reviewed corrections to how a file is DESCRIBED where the run's draft does not fit HCG Store's record
   * (a minimum OS written as a sentence; a bundle identifier in the Debian-only package field). Never the bytes,
   * size, hash, platform, architecture, format, kind or provenance.
   */
  reviewedFileFields: z.record(z.string(), z.strictObject({
    minimumOs: z.string().trim().min(1).max(40).optional(),
    package: z.null().optional(),
  })).optional(),
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

/**
 * Files HCG Store verified and refused for publication (release-imports/rejected-artifacts.json; a test keeps the two
 * lists equal). No import accepts them, whatever their name or request.
 */
export const REJECTED_SHA256: ReadonlySet<string> = new Set([
  "72029dbd965e4d9cda1f429b55552810eb15a71fc1b0e34cfc42d4fd79610a91", // HCG.Mail.app.zip: broken ad-hoc signature, not notarized
  "84dc5b50f6ac59bc7f6e4b62f1c626ce548b0a7f4171a433f4c499a67013cc00", // HCG.Mail-1.0.0-osx-arm64.pkg: unsigned, not notarized
]);

export function refuseRejected(draft: ImportDraft): void {
  for (const a of draft.artifacts as { fileName?: string; sha256?: string }[]) {
    if (a.sha256 && REJECTED_SHA256.has(a.sha256)) throw new HttpError(400, "artifact_rejected", `${a.fileName}: HCG Store refused this file earlier (rejected-artifacts.json). It is never imported.`);
  }
}

/** The committed request's reviewed changes to a CI run's draft (release notes, Store-verified notarization). */
export function withReviewedChanges(request: ImportRequest, draft: ImportDraft): ImportDraft {
  if (request.source.kind === "github-release") {
    if (request.reviewedReleaseNotes || request.storeVerifiedSigning || request.reviewedFileFields) throw new HttpError(400, "request_mismatch", "A GitHub release import declares its release record directly.");
    return draft;
  }
  const names = new Set((draft.artifacts as { fileName: string }[]).map((a) => a.fileName));
  for (const n of [...Object.keys(request.storeVerifiedSigning ?? {}), ...Object.keys(request.reviewedFileFields ?? {})]) {
    if (!names.has(n)) throw new HttpError(400, "request_mismatch", `The request names ${n}, which the draft does not list.`);
  }
  const artifacts = (draft.artifacts as { fileName: string; signing?: { status?: string } }[]).map((orig) => {
    const fields = request.reviewedFileFields?.[orig.fileName];
    const a = fields ? { ...orig, ...fields } : orig;
    const v = request.storeVerifiedSigning?.[a.fileName];
    if (!v) return a;
    if (a.signing?.status !== "signed") throw new HttpError(400, "request_mismatch", `${a.fileName}: only a file the run reports as signed can be recorded as notarized (the run says ${a.signing?.status ?? "nothing"}).`);
    return { ...a, signing: { status: "notarized", evidence: v.evidence } };
  });
  return { release: request.reviewedReleaseNotes ? { ...draft.release, releaseNotes: request.reviewedReleaseNotes } : draft.release, artifacts };
}
