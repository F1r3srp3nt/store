/**
 * Release records: what a person approved for public delivery in HCG Store (Ship to Store), exported so the public
 * catalogue (`catalogue/releases.json`) can be generated from it. The manual approval in HCG Store is the release
 * review: a person HCG allows to approve the product, other than the creator, typing the version, recorded in the
 * hash-chained audit. Generating the catalogue from these records adds no second review.
 *
 * Only releases a person also PUBLISHED (the explicit step after approval) are exported, including those later
 * superseded or withdrawn; an approved but unpublished release is not.
 *
 * The export never contains a file location, a download URL, an account ID or a token. It is refused when the audit
 * chain does not verify.
 */
import { sha256Hex } from "./crypto";

/** The subset of node:sqlite this module needs, so the CLI can open the database read-only. */
interface ReadDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

export const RELEASE_RECORDS_FORMAT = "hcg.store.release-records/1";

export interface ReleaseRecordArtifact {
  id: string;
  platform: string;
  format: string;
  fileName: string;
  architectures: string[];
  minimumOs: string | null;
  sizeBytes: number;
  sha256: string;
  signingReported: { status: string; evidence: string | null; tool: string | null };
  /** Build provenance reported at upload (source commit, build provider, toolchain); null for older uploads. */
  provenance?: { sourceCommit: string | null; buildProvider: string | null; toolchain: string | null } | null;
}

export interface ReleaseRecord {
  storeReleaseId: string;
  productId: string;
  editionId: string | null;
  version: string;
  build: string;
  channel: string;
  distribution: string;
  /** "approved" (published, possibly superseded since) or "withdrawn", as the catalogue knows them. */
  status: "approved" | "withdrawn";
  /** The Store's own lifecycle state. */
  lifecycle?: "published" | "superseded" | "withdrawn";
  approvedAt: number;
  /** Absent in exports made before the publication step existed. */
  publishedAt?: number;
  /** The person publishing (or approving) chose to make this the product's current release in the catalogue. */
  current: boolean;
  /** Hash of the `release.approved` audit entry (the review record). */
  approvalAudit: string;
  withdrawnAt: number | null;
  withdrawnReason: string | null;
  releaseNotes: string[];
  artifacts: ReleaseRecordArtifact[];
}

export interface ReleaseRecordsExport {
  format: typeof RELEASE_RECORDS_FORMAT;
  exportedAt: number;
  auditIntact: boolean;
  records: ReleaseRecord[];
}

type AuditRow = { at: number; actor: string; action: string; release_id: string | null; artifact_id: string | null; detail: string; prev_hash: string; hash: string };

/** Recomputes the publishing audit chain; false when any entry was altered or removed outside the API. */
export function auditChainIntact(db: ReadDb): boolean {
  let prev = "0".repeat(64);
  for (const r of db.prepare("SELECT * FROM pub_audit ORDER BY seq").all() as AuditRow[]) {
    if (r.prev_hash !== prev) return false;
    const h = sha256Hex(`${prev}|${r.at}|${r.actor}|${r.action}|${r.release_id ?? ""}|${r.artifact_id ?? ""}|${r.detail}`);
    if (h !== r.hash) return false;
    prev = h;
  }
  return true;
}

export function exportReleaseRecords(db: ReadDb, now: number): ReleaseRecordsExport {
  const releases = db
    .prepare(
      `SELECT id, product_id, edition_id, version, build, channel, distribution, status, approved_at, published_at, updated_at, withdrawn_reason, release_notes
       FROM pub_releases WHERE approved_eligibility = 'public' AND published_at IS NOT NULL AND status IN ('published', 'superseded', 'withdrawn')
         AND product_source = 'catalogue'
       ORDER BY published_at, id`,
    )
    .all() as {
    id: string; product_id: string; edition_id: string | null; version: string; build: string; channel: string; distribution: string;
    status: "published" | "superseded" | "withdrawn"; approved_at: number; published_at: number; updated_at: number; withdrawn_reason: string | null; release_notes: string;
  }[];
  const records: ReleaseRecord[] = [];
  for (const r of releases) {
    const approval = db
      .prepare("SELECT hash, detail FROM pub_audit WHERE action = 'release.approved' AND release_id = ? ORDER BY seq DESC LIMIT 1")
      .get(r.id) as { hash: string; detail: string } | undefined;
    if (!approval) continue; // no review record: never exported
    const detail = JSON.parse(approval.detail) as { eligibility?: string; current?: boolean };
    if (detail.eligibility !== "public") continue;
    const publication = db
      .prepare("SELECT detail FROM pub_audit WHERE action = 'release.published' AND release_id = ? ORDER BY seq DESC LIMIT 1")
      .get(r.id) as { detail: string } | undefined;
    if (!publication) continue; // never published: not exported
    const published = JSON.parse(publication.detail) as { current?: boolean };
    const artifacts = (
      db
        .prepare(
          `SELECT id, platform, format, file_name, architectures, minimum_os, size_bytes, sha256, signing_reported, provenance
           FROM pub_artifacts WHERE release_id = ? AND status = 'verified' AND format NOT IN ('aab') ORDER BY created_at, id`,
        )
        .all(r.id) as { id: string; platform: string; format: string; file_name: string; architectures: string; minimum_os: string | null; size_bytes: number; sha256: string; signing_reported: string; provenance: string | null }[]
    ).map((a) => ({
      id: a.id,
      platform: a.platform,
      format: a.format,
      fileName: a.file_name,
      architectures: JSON.parse(a.architectures) as string[],
      minimumOs: a.minimum_os,
      sizeBytes: a.size_bytes,
      sha256: a.sha256,
      signingReported: JSON.parse(a.signing_reported) as ReleaseRecordArtifact["signingReported"],
      provenance: a.provenance ? (({ sourceCommit, buildProvider, toolchain }) => ({ sourceCommit, buildProvider, toolchain }))(JSON.parse(a.provenance) as { sourceCommit: string | null; buildProvider: string | null; toolchain: string | null }) : null,
    }));
    records.push({
      storeReleaseId: r.id,
      productId: r.product_id,
      editionId: r.edition_id,
      version: r.version,
      build: r.build,
      channel: r.channel,
      distribution: r.distribution,
      status: r.status === "withdrawn" ? "withdrawn" : "approved",
      lifecycle: r.status,
      approvedAt: r.approved_at,
      publishedAt: r.published_at,
      current: published.current === true && r.status === "published",
      approvalAudit: approval.hash,
      withdrawnAt: r.status === "withdrawn" ? r.updated_at : null,
      withdrawnReason: r.status === "withdrawn" ? r.withdrawn_reason : null,
      releaseNotes: JSON.parse(r.release_notes) as string[],
      artifacts,
    });
  }
  return { format: RELEASE_RECORDS_FORMAT, exportedAt: now, auditIntact: auditChainIntact(db), records };
}
