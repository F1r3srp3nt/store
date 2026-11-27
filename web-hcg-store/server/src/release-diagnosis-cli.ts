/**
 * Operator diagnosis (read-only): the state of every release in HCG Store, its files, founder exceptions, current
 * targets and the recent publishing audit, to explain why an approval or publication is refused. Opens the database
 * read-only and changes nothing. Account IDs never appear: each account is shown as a one-way reference (the first
 * 10 hex of SHA-256 over a fixed prefix and the account ID), so the same person has the same reference throughout,
 * and sign-in sessions (session_ref, as in mode=evidence) are mapped to those references.
 *
 *   node server-dist/with-machine-env.mjs /tmp/release-diagnosis.mjs
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.HCG_STORE_DATA_DIR ?? "data";
const db = new DatabaseSync(join(dataDir, "hcg-store.sqlite"), { readOnly: true });
const ref = (s: string | null | undefined) => {
  if (!s) return null;
  // CI imports and operators are not accounts: keep their label.
  if (/^(import:|operator:|migration|system|ci:)/.test(s)) return s.slice(0, 120);
  return `acct-${createHash("sha256").update(`hcg-store-diagnosis:${s}`).digest("hex").slice(0, 10)}`;
};
const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Record<string, unknown>[];
const cols = (t: string) => new Set((all(`PRAGMA table_info(${t})`) as { name: string }[]).map((c) => c.name));
const rc = cols("pub_releases");

const releases = all(`SELECT * FROM pub_releases ORDER BY updated_at DESC LIMIT 60`).map((r) => {
  const arts = all(`SELECT id, file_name, platform, format, architectures, size_bytes, status, sha256, declared_sha256, signing_reported, validation, provenance FROM pub_artifacts WHERE release_id = ? ORDER BY file_name`, r.id as string);
  const submitter = (all(`SELECT actor FROM pub_audit WHERE action = 'release.submitted' AND release_id = ? ORDER BY seq DESC LIMIT 1`, r.id as string)[0]?.actor as string | undefined) ?? null;
  const verified = arts.filter((a) => a.status === "verified").map((a) => `${a.sha256}  ${a.file_name}`).sort();
  const digest = verified.length ? createHash("sha256").update(verified.join("\n")).digest("hex") : null;
  const exceptions = all(`SELECT id, subject, artifact_digest, created_at, revoked_at, performed_by FROM release_exceptions WHERE release_id = ? ORDER BY created_at`, r.id as string)
    .map((x) => ({ id: x.id, subject: ref(x.subject as string), appliesToCurrentFiles: x.revoked_at === null && x.artifact_digest === digest, revoked: x.revoked_at !== null, createdAt: iso(x.created_at as number), performedBy: x.performed_by }));
  return {
    id: r.id, productId: r.product_id, editionId: r.edition_id, version: r.version, build: r.build, channel: r.channel, status: r.status,
    availability: rc.has("availability") ? r.availability : null, requestedEligibility: r.requested_eligibility, approvedEligibility: r.approved_eligibility,
    distribution: r.distribution, uploadSource: rc.has("upload_source") ? r.upload_source : null,
    createdBy: ref(r.created_by as string), submittedBy: ref(submitter), approvedBy: ref(r.approved_by as string), publishedBy: ref((r.published_by as string) ?? null),
    sameCreatorAndSubmitter: r.created_by === submitter,
    createdAt: iso(r.created_at as number), submittedAt: iso(r.submitted_at as number), approvedAt: iso(r.approved_at as number), publishedAt: iso((r.published_at as number) ?? null), updatedAt: iso(r.updated_at as number),
    importedFrom: r.imported_from ? (() => { const o = JSON.parse(r.imported_from as string); return { kind: o.kind ?? "ci-run", repository: o.repository, tag: o.tag, runId: o.runId }; })() : null,
    files: arts.map((a) => {
      const v = a.validation ? JSON.parse(a.validation as string) : null;
      const prov = a.provenance ? JSON.parse(a.provenance as string) : null;
      return { id: a.id, fileName: a.file_name, platform: a.platform, format: a.format, architectures: JSON.parse(a.architectures as string), sizeBytes: a.size_bytes, status: a.status,
        sha256: a.sha256 ?? null, declaredSha256Matches: a.sha256 ? a.sha256 === a.declared_sha256 : null, signing: JSON.parse(a.signing_reported as string).status,
        problems: v?.problems ?? [], provenance: prov ? { buildProvider: prov.buildProvider, sourceCommit: prov.sourceCommit ? String(prov.sourceCommit).slice(0, 12) : null, toolchain: !!prov.toolchain } : null };
    }),
    filesDigest: digest, exceptions,
  };
});
const current = all(`SELECT product_id, edition_key, platform, arch, channel, release_id, selected_at, selected_by FROM pub_current ORDER BY product_id, platform`).map((c) => ({ ...c, selected_by: ref(c.selected_by as string), selected_at: iso(c.selected_at as number) }));
const audit = all(`SELECT seq, at, actor, action, release_id, artifact_id, detail FROM pub_audit ORDER BY seq DESC LIMIT 80`).map((a) => {
  const d = JSON.parse(a.detail as string) as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of ["via", "eligibility", "current", "reason", "code", "problems", "governance", "exceptionId", "supersede", "superseded", "availability", "from", "to", "fileName", "version"]) if (k in d) keep[k] = d[k];
  return { seq: a.seq, at: iso(a.at as number), actor: ref(a.actor as string), action: a.action, release: a.release_id, artifact: a.artifact_id, detail: keep };
});
// Recent sign-ins (session_ref as in mode=evidence) and whose account they are.
const sessions = all(`SELECT substr(id_hash, 1, 12) AS session_ref, sub, created_at, last_seen_at, ended_at FROM sessions ORDER BY created_at DESC LIMIT 12`)
  .map((s) => ({ session_ref: s.session_ref, account: ref(s.sub as string), createdAt: iso(s.created_at as number), lastSeenAt: iso(s.last_seen_at as number), ended: s.ended_at !== null }));
process.stdout.write(JSON.stringify({ format: "hcg.store.release-diagnosis/1", generatedAt: new Date().toISOString(), releases, current, audit, sessions }) + "\n");
