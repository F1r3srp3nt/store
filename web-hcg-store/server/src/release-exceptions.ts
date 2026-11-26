/**
 * Founder-operated release exceptions.
 *
 * HCG Store's rule is that the person who submits a release (or creates it) is not the person who approves it for
 * public delivery or publishes it. A CI build is never counted as that "other person": when a CI import is submitted
 * by someone, that someone is the submitter, and the rule applies to them.
 *
 * An exception lets ONE named person (an HCG account, identified by a sign-in HCG Store verified and matched with
 * HCG's /me) submit, approve and publish ONE specific release with ONE exact set of files. It is:
 *   - granted only by the operator path (release-exception CLI via the deploy workflow), with who authorised and who
 *     performed it and a reason, also written to the hash-chained publishing audit;
 *   - bound to the release's verified files (SHA-256 of the sorted "sha256  name" lines): if any file changes, the
 *     exception no longer applies;
 *   - shown on the review page and recorded on each approval and publication it was used for;
 *   - revocable, never deleted, and never a permission: the person still needs HCG's store.publish,
 *     store.release.approve and store.release.publish for each separate step.
 */
import { createHash, randomBytes } from "node:crypto";
import { transaction, type Db } from "./db";
import { appendPubAudit } from "./release-records";

export class ReleaseExceptionError extends Error {}

export interface ReleaseException {
  id: string;
  releaseId: string;
  kind: "founder-operated";
  artifactDigest: string;
  reason: string;
  authorisedBy: string;
  performedBy: string;
  createdAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
}

type Row = {
  id: string; release_id: string; kind: string; subject: string; artifact_digest: string; reason: string; authorised_by: string; performed_by: string;
  created_at: number; revoked_at: number | null; revoked_reason: string | null;
};

const view = (r: Row): ReleaseException => ({
  id: r.id, releaseId: r.release_id, kind: "founder-operated", artifactDigest: r.artifact_digest, reason: r.reason, authorisedBy: r.authorised_by,
  performedBy: r.performed_by, createdAt: r.created_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason,
});

/** Digest of a release's verified files: SHA-256 over the sorted "sha256  file name" lines. */
export function artifactSetDigest(db: Db, releaseId: string): string | null {
  const rows = db.prepare("SELECT sha256, file_name FROM pub_artifacts WHERE release_id = ? AND status = 'verified' ORDER BY sha256, file_name").all(releaseId) as { sha256: string; file_name: string }[];
  if (!rows.length) return null;
  return createHash("sha256").update(rows.map((r) => `${r.sha256}  ${r.file_name}`).join("\n")).digest("hex");
}

/** The exception that lets `subject` act on this release now (unrevoked, and the files are still the same), if any. */
export function activeException(db: Db, releaseId: string, subject: string): ReleaseException | null {
  const r = db.prepare("SELECT * FROM release_exceptions WHERE release_id = ? AND subject = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(releaseId, subject) as Row | undefined;
  if (!r) return null;
  return r.artifact_digest === artifactSetDigest(db, releaseId) ? view(r) : null;
}

/** Exceptions recorded for a release (for the review page; no account IDs). */
export function exceptionsFor(db: Db, releaseId: string): (ReleaseException & { appliesToCurrentFiles: boolean })[] {
  const digest = artifactSetDigest(db, releaseId);
  return (db.prepare("SELECT * FROM release_exceptions WHERE release_id = ? ORDER BY created_at").all(releaseId) as Row[])
    .map((r) => ({ ...view(r), appliesToCurrentFiles: r.revoked_at === null && r.artifact_digest === digest }));
}

const clean = (v: string, max: number, what: string) => {
  const t = v.trim();
  if (!t) throw new ReleaseExceptionError(`${what} is required.`);
  if (t.length > max) throw new ReleaseExceptionError(`${what} is at most ${max} characters.`);
  return t;
};

export function grantFounderException(
  db: Db,
  input: { releaseId: string; subject: string; reason: string; authorisedBy: string; performedBy: string; expectDigest?: string | null },
  now: number,
): ReleaseException {
  const rel = db.prepare("SELECT id, status FROM pub_releases WHERE id = ?").get(input.releaseId) as { id: string; status: string } | undefined;
  if (!rel) throw new ReleaseExceptionError("No such release.");
  if (!["draft", "submitted", "approved"].includes(rel.status)) throw new ReleaseExceptionError(`The release is ${rel.status}; an exception is for a release not yet published.`);
  const digest = artifactSetDigest(db, rel.id);
  if (!digest) throw new ReleaseExceptionError("The release has no verified files yet.");
  if (input.expectDigest && input.expectDigest !== digest) throw new ReleaseExceptionError(`The release's files are not the ones expected (digest ${digest}).`);
  if (!/^[A-Za-z0-9._:@|-]{1,200}$/.test(input.subject)) throw new ReleaseExceptionError("Unusable account reference.");
  const existing = db.prepare("SELECT id FROM release_exceptions WHERE release_id = ? AND revoked_at IS NULL").get(rel.id) as { id: string } | undefined;
  if (existing) throw new ReleaseExceptionError(`Exception ${existing.id} is already recorded for this release; revoke it first.`);
  const reason = clean(input.reason, 1000, "A reason");
  const authorisedBy = clean(input.authorisedBy, 300, "Who authorised it");
  const performedBy = clean(input.performedBy, 300, "Who performed it");
  const id = `rx-${randomBytes(6).toString("hex")}`;
  transaction(db, () => {
    db.prepare(`INSERT INTO release_exceptions (id, release_id, kind, subject, artifact_digest, reason, authorised_by, performed_by, created_at)
                VALUES (?, ?, 'founder-operated', ?, ?, ?, ?, ?, ?)`).run(id, rel.id, input.subject, digest, reason, authorisedBy, performedBy, now);
    appendPubAudit(db, now, `operator:${performedBy}`.slice(0, 200), "release.exception-granted", rel.id, null, {
      exceptionId: id, kind: "founder-operated", artifactDigest: digest, reason, authorisedBy, performedBy,
      note: "One person may submit, approve and publish this release with these exact files. Not an independent review.",
    });
  });
  return view(db.prepare("SELECT * FROM release_exceptions WHERE id = ?").get(id) as Row);
}

export function revokeException(db: Db, id: string, input: { reason: string; authorisedBy: string; performedBy: string }, now: number): ReleaseException {
  const r = db.prepare("SELECT * FROM release_exceptions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new ReleaseExceptionError("No such exception.");
  if (r.revoked_at !== null) return view(r);
  const reason = clean(input.reason, 1000, "A reason");
  const authorisedBy = clean(input.authorisedBy, 300, "Who authorised it");
  const performedBy = clean(input.performedBy, 300, "Who performed it");
  transaction(db, () => {
    db.prepare("UPDATE release_exceptions SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(now, reason, id);
    appendPubAudit(db, now, `operator:${performedBy}`.slice(0, 200), "release.exception-revoked", r.release_id, null, { exceptionId: id, reason, authorisedBy, performedBy });
  });
  return view(db.prepare("SELECT * FROM release_exceptions WHERE id = ?").get(id) as Row);
}
