/**
 * Ship to Store: release publishing for HCG Executable Maker (and the Store's own review page).
 *
 *   GET    /api/v1/publishing/whoami                         who is calling; publisher/approver per HCG
 *   GET    /api/v1/publishing/products                       products the caller may publish
 *   POST   /api/v1/publishing/products                       draft product (Store-internal until HCG adds it)
 *   GET    /api/v1/publishing/releases?productId=            releases of a product
 *   POST   /api/v1/publishing/releases                       private draft release
 *   GET    /api/v1/publishing/releases/:id                   release, artifacts, validation, audit
 *   POST   /api/v1/publishing/releases/:id/artifacts         declare a file → short-lived scoped upload URL
 *   POST   /api/v1/publishing/artifacts/:id/upload-url       renew the upload URL (resume after expiry)
 *   PUT    /publishing-upload/v1/:token                      upload a chunk (Content-Range), resumable
 *   GET    /publishing-upload/v1/:token                      bytes received so far
 *   POST   /api/v1/publishing/artifacts/:id/complete         hash + validate + move to immutable storage
 *   DELETE /api/v1/publishing/artifacts/:id                  abort an upload / remove a file from a draft
 *   POST   /api/v1/publishing/releases/:id/submit            submit for manual review
 *   POST   /api/v1/publishing/releases/:id/approve           MANUAL approval in the Store (web session only)
 *   POST   /api/v1/publishing/releases/:id/withdraw          rollback: stop delivery, keep files and history
 *   POST   /api/v1/publishing/artifacts/:id/download-url     short-lived scoped download URL (authorised)
 *   GET    /publishing-download/v1/:token                    the file (re-authorised at use)
 *   GET    /publishing/releases/:id                          review page (web session)
 *
 * Authority: HCG Connect identifies the caller (Store session cookie, or a bearer access token issued to an
 * allow-listed client such as HCG Executable Maker). HCG's entitlement authority decides who may publish and
 * approve (central permission IDs) and who owns a product. The Store keeps no roles and no permission table.
 * Files are private; every URL is short-lived, scoped to one file and one person, and re-checked when used.
 * Nothing here publishes to external stores or TestFlight.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { ALLOWED, checkDeclaration, CONTENT_TYPES, FORMATS, inspectContent, installReadiness, kindFromFormat, KINDS, PLATFORMS, type ArtifactKind, type ContentReport, type PublishFormat, type PublishPlatform } from "./artifact-validation";
import type { StoreConfig } from "./config";
import { seal, sha256Hex, signPayload, unseal, verifyPayload, randomToken } from "./crypto";
import { transaction, type Db } from "./db";
import { auditChainIntact } from "./release-records";
import type { EntitlementAuthority, Subject } from "./entitlements";
import type { HcgConnectClient } from "./hcg-connect";
import { assertSameOrigin, errorJson, escapeHtml, html, HttpError, json, readJson } from "./http";
import { findByPackageId, findProduct, type ProtectedArtifact, type Registry } from "./registry";
import type { Session } from "./sessions";
import { isSemver } from "../../src/domain/version";

export interface Actor {
  sub: string;
  accessToken: string | null;
  /** "web": Store session in a browser; "desktop": bearer token from an allow-listed HCG Connect client. */
  via: "web" | "desktop";
  email?: string | null;
}

export interface PublishingDeps {
  cfg: StoreConfig;
  db: Db;
  registry: Registry;
  connect: HcgConnectClient | null;
  authority: EntitlementAuthority;
  now: () => number;
  freshSession: (req: IncomingMessage) => Promise<{ session: Session | null; unavailable: boolean }>;
  streamArtifact: (res: ServerResponse, storageKey: string, fileName: string, contentType: string) => void;
}

/** A Debian version Sileo's authorize_download will match to this release: the version, or `<version>-<revision>`. */
export function debianVersionMatches(debVersion: string, releaseVersion: string): boolean {
  if (debVersion === releaseVersion) return true;
  return debVersion.startsWith(`${releaseVersion}-`) && /^[A-Za-z0-9.+~]+$/.test(debVersion.slice(releaseVersion.length + 1));
}

/** HCG Store's own central product (registered: main-site handoff, 16 Nov 2026). */
export const STORE_CENTRAL_PRODUCT_ID = "hcg.store";

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hex64 = /^[a-f0-9]{64}$/;
const text = z.string().trim().min(1).max(2000);

const ReleaseInput = z.strictObject({
  productId: z.string().regex(kebab),
  editionId: z.string().regex(kebab).nullable().default(null),
  version: z.string().refine(isSemver, "Version must be Semantic Versioning, e.g. 1.2.0 or 0.3.0-beta.1."),
  build: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "Build number: letters, digits and . _ + -"),
  channel: z.enum(["beta", "stable"]).default("beta"),
  releaseNotes: z.array(text).max(50).default([]),
  compatibility: z
    .strictObject({
      minimumOs: z.partialRecord(z.enum(PLATFORMS), z.string().trim().max(40)).default({}),
      architectures: z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/)).max(12).default([]),
      notes: z.array(text).max(20).default([]),
    })
    .default({ minimumOs: {}, architectures: [], notes: [] }),
  distribution: z.enum(["free", "paid", "subscription", "entitlement"]),
  eligibility: z.enum(["private", "internal-testing", "public"]),
  destinations: z.array(z.enum(["hcg-store", "hcg-repo"])).min(1).default(["hcg-store"]),
});

const ArtifactInput = z.strictObject({
  fileName: z.string(),
  platform: z.enum(PLATFORMS),
  format: z.enum(FORMATS),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(hex64, "SHA-256 must be 64 lowercase hexadecimal characters."),
  architectures: z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/)).max(12).default([]),
  minimumOs: z.string().trim().max(40).nullable().default(null),
  /** What the uploading tool verified (codesign/spctl/stapler/signtool…). Recorded as REPORTED, never as Store-verified. */
  signing: z
    .strictObject({
      status: z.enum(["not-checked", "unsigned", "signed", "notarized", "invalid"]),
      evidence: z.string().trim().max(4000).nullable().default(null),
      tool: z.string().trim().max(200).nullable().default(null),
    })
    .default({ status: "not-checked", evidence: null, tool: null }),
  /** What the uploader says the file is. The Store decides the kind from the content and refuses a mismatch. */
  kind: z.enum(KINDS).nullable().default(null),
  /** Debian control fields read by the uploading tool (HCG Repo destination). */
  package: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9.+-]+$/), version: z.string().max(100), architecture: z.string().max(40) }).nullable().default(null),
});

type ReleaseRow = {
  id: string; product_id: string; product_source: "catalogue" | "draft"; edition_id: string | null; version: string; build: string; channel: string;
  release_notes: string; compatibility: string; distribution: string; requested_eligibility: string; destinations: string; status: string;
  approved_eligibility: string | null; created_by: string; created_at: number; updated_at: number; submitted_at: number | null;
  approved_by: string | null; approved_at: number | null; withdrawn_reason: string | null;
};
type ArtifactRow = {
  id: string; release_id: string; file_name: string; platform: string; format: string; architectures: string; minimum_os: string | null;
  size_bytes: number; declared_sha256: string; sha256: string | null; status: string; storage_key: string | null; content_type: string;
  validation: string | null; signing_reported: string; package: string | null; created_at: number; completed_at: number | null;
  declared_kind: string | null;
};

const ELIGIBILITY_RANK = { private: 0, "internal-testing": 1, public: 2 } as const;

export function createPublishing(deps: PublishingDeps) {
  const { cfg, db, registry, authority, now } = deps;
  const P = cfg.publishing;
  const storageRoot = resolve(cfg.artifactStorageDir || ".");
  const uploading = new Set<string>();

  // ------------------------------------------------------------- audit (append-only, hash-chained)

  function audit(actor: string, action: string, releaseId: string | null, artifactId: string | null, detail: object) {
    const prev = (db.prepare("SELECT hash FROM pub_audit ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined)?.hash ?? "0".repeat(64);
    const at = now();
    const body = JSON.stringify(detail);
    const hash = sha256Hex(`${prev}|${at}|${actor}|${action}|${releaseId ?? ""}|${artifactId ?? ""}|${body}`);
    db.prepare("INSERT INTO pub_audit (at, actor, action, release_id, artifact_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at, actor, action, releaseId, artifactId, body, prev, hash);
  }

  /** Recomputes the audit chain; false when any row was altered outside the API. */
  const auditIntact = () => auditChainIntact(db);

  // ------------------------------------------------------------- who is calling, and what HCG allows

  async function actorOf(req: IncomingMessage): Promise<Actor> {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      if (!deps.connect) throw new HttpError(503, "hcg_connect_not_configured", "HCG Connect is not configured for this Store.");
      try {
        const payload = await deps.connect.verifyAccessTokenFrom(auth.slice(7).trim(), P.clientIds);
        return { sub: payload.sub!, accessToken: auth.slice(7).trim(), via: "desktop", email: typeof payload.email === "string" ? payload.email : null };
      } catch (e) {
        throw new HttpError(401, "invalid_token", `HCG Connect did not confirm this sign-in: ${(e as Error).message}`);
      }
    }
    const fresh = await deps.freshSession(req);
    if (fresh.unavailable) throw new HttpError(503, "hcg_unavailable", "Your sign-in could not be checked right now. Nothing was changed.");
    if (!fresh.session) throw new HttpError(401, "sign_in_required", "Sign in with HCG Connect.");
    return { sub: fresh.session.sub, accessToken: fresh.session.accessToken, via: "web", email: fresh.session.email };
  }

  /**
   * HCG's contract (main-site Maker/Store handoff v2, 17 Nov 2026): `store.publish` and `store.release.approve` are
   * personal grants on HCG Store's own central product, `hcg.store`, whatever product is being published. A Maker
   * licence, a purchase, organisation membership or another product's permission never counts.
   */
  function permissionScope(_productId: string): string {
    return STORE_CENTRAL_PRODUCT_ID;
  }

  async function permitted(actor: Actor, permission: "publish" | "approve", productId: string): Promise<boolean> {
    const feature = permission === "publish" ? P.publisherCentralId! : P.approverCentralId!;
    const subject: Subject = { sub: actor.sub, accessToken: actor.accessToken };
    // A central feature of the product (HCG's planned staff permissions `store.publish` and `store.release.approve`),
    // checked with the caller's own HCG token on every action and never cached. Owning the product, an HCG role, or
    // anything the client sends grants nothing. Until HCG creates the features, /check answers feature_unavailable
    // and the answer is "not permitted".
    const r = await authority.checkFeature(subject, permissionScope(productId), feature);
    if (r.status === "unavailable") throw new HttpError(503, "hcg_unavailable", "HCG could not confirm your publishing permission right now. Nothing was changed.");
    return r.status === "granted";
  }

  async function requirePermission(actor: Actor, permission: "publish" | "approve", productId: string) {
    if (!(await permitted(actor, permission, productId))) {
      throw new HttpError(403, permission === "publish" ? "not_publisher" : "not_approver",
        permission === "publish" ? "HCG has not granted your account permission to publish this product." : "HCG has not granted your account permission to approve releases of this product.");
    }
  }

  // ------------------------------------------------------------- products and releases

  function productInfo(productId: string): { source: "catalogue" | "draft"; title: string; editions: string[]; centralId: string | null; packageIds: string[] } | null {
    const p = findProduct(registry, productId);
    if (p) return { source: "catalogue", title: p.name, editions: p.editions.map((e) => e.id), centralId: p.registry.centralId, packageIds: p.editions.flatMap((e) => e.identifiers.filter((i) => i.kind === "debian-package").map((i) => i.value)) };
    const d = db.prepare("SELECT title FROM pub_products WHERE id = ?").get(productId) as { title: string } | undefined;
    return d ? { source: "draft", title: d.title, editions: [], centralId: null, packageIds: [] } : null;
  }

  const release = (id: string) => db.prepare("SELECT * FROM pub_releases WHERE id = ?").get(id) as ReleaseRow | undefined;
  const artifact = (id: string) => db.prepare("SELECT * FROM pub_artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  const artifactsOf = (releaseId: string) => db.prepare("SELECT * FROM pub_artifacts WHERE release_id = ? ORDER BY created_at, id").all(releaseId) as ArtifactRow[];

  function releaseView(r: ReleaseRow, withAudit = true) {
    const pinfo = productInfo(r.product_id);
    return {
      id: r.id, productId: r.product_id, productTitle: pinfo?.title ?? r.product_id, productSource: r.product_source, editionId: r.edition_id,
      version: r.version, build: r.build, channel: r.channel, releaseNotes: JSON.parse(r.release_notes), compatibility: JSON.parse(r.compatibility),
      distribution: r.distribution, requestedEligibility: r.requested_eligibility, destinations: JSON.parse(r.destinations), status: r.status,
      approvedEligibility: r.approved_eligibility, createdBy: r.created_by, createdAt: r.created_at, submittedAt: r.submitted_at,
      approvedBy: r.approved_by, approvedAt: r.approved_at, withdrawnReason: r.withdrawn_reason,
      reviewUrl: `${cfg.publicOrigin}/publishing/releases/${r.id}`,
      artifacts: artifactsOf(r.id).map(artifactView),
      audit: withAudit
        ? (db.prepare("SELECT seq, at, actor, action, artifact_id, detail FROM pub_audit WHERE release_id = ? ORDER BY seq").all(r.id) as { seq: number; at: number; actor: string; action: string; artifact_id: string | null; detail: string }[])
            .map((a) => ({ ...a, detail: JSON.parse(a.detail) }))
        : undefined,
    };
  }

  function artifactView(a: ArtifactRow) {
    const up = db.prepare("SELECT received_bytes FROM pub_uploads WHERE artifact_id = ?").get(a.id) as { received_bytes: number } | undefined;
    const validation = a.validation ? (JSON.parse(a.validation) as { content: ContentReport | null; signatureStructure: ContentReport["signature"] }) : null;
    const reported = (JSON.parse(a.signing_reported) as { status: string }).status;
    // The Store's own finding wins; before the upload is complete only the declaration (or the format) is known.
    const kind = (validation?.content?.kind ?? a.declared_kind ?? kindFromFormat(a.platform, a.format) ?? undefined) as ArtifactKind | undefined;
    const readiness = installReadiness(a.platform, kind, validation?.signatureStructure ?? "not-checked", reported, validation?.content?.ios);
    return {
      kind, declaredKind: a.declared_kind, kindCheckedByStore: Boolean(validation?.content?.kind), readiness,
      id: a.id, fileName: a.file_name, platform: a.platform, format: a.format, architectures: JSON.parse(a.architectures), minimumOs: a.minimum_os,
      sizeBytes: a.size_bytes, declaredSha256: a.declared_sha256, sha256: a.sha256, status: a.status, receivedBytes: up?.received_bytes ?? (a.status === "verified" ? a.size_bytes : 0),
      validation: a.validation ? JSON.parse(a.validation) : null, signingReported: JSON.parse(a.signing_reported), package: a.package ? JSON.parse(a.package) : null,
      createdAt: a.created_at, completedAt: a.completed_at,
    };
  }

  // ------------------------------------------------------------- upload URLs

  function uploadUrl(artifactId: string, sub: string) {
    const exp = now() + P.uploadUrlTtlSeconds * 1000;
    return { uploadUrl: `${cfg.publicOrigin}/publishing-upload/v1/${signPayload(cfg.secretKey, "publishing-upload", { a: artifactId, s: sub, exp })}`, expiresAt: exp, chunkBytes: P.chunkBytes };
  }

  function stagingPath(key: string) {
    const f = resolve(storageRoot, key);
    if (!f.startsWith(storageRoot + sep)) throw new HttpError(400, "bad_path", "Refused storage path.");
    return f;
  }

  async function putChunk(req: IncomingMessage, res: ServerResponse, token: string) {
    const t = verifyPayload<{ a: string; s: string; exp: number }>(cfg.secretKey, "publishing-upload", token);
    if (!t || t.exp < now()) return errorJson(res, 403, "upload_url_expired", "This upload URL has expired. Ask for a new one; the bytes already received are kept.");
    const a = artifact(t.a);
    const up = db.prepare("SELECT * FROM pub_uploads WHERE artifact_id = ?").get(t.a) as { received_bytes: number; staging_key: string; attempts: number } | undefined;
    if (!a || !up || !["awaiting-upload", "uploading"].includes(a.status)) return errorJson(res, 409, "not_uploading", "This file is not waiting for an upload.");
    const r = release(a.release_id)!;
    if (r.status !== "draft") return errorJson(res, 409, "release_locked", "The release is no longer a draft.");
    if (req.method === "GET") return json(res, 200, { received: up.received_bytes, size: a.size_bytes, chunkBytes: P.chunkBytes });
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"] ?? ""));
    if (!m) return errorJson(res, 400, "content_range_required", "Send Content-Range: bytes start-end/total.");
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const length = end - start + 1;
    if (total !== a.size_bytes || end >= total || length <= 0 || length > P.chunkBytes) return errorJson(res, 400, "bad_range", "The range does not match the declared file.");
    if (start !== up.received_bytes) return json(res, 409, { error: "offset_mismatch", message: `Resume at byte ${up.received_bytes}.`, received: up.received_bytes });
    if (uploading.has(a.id)) return errorJson(res, 409, "upload_in_progress", "Another chunk of this file is being received.");
    uploading.add(a.id);
    const file = stagingPath(up.staging_key);
    mkdirSync(dirname(file), { recursive: true });
    let written = 0;
    try {
      await new Promise<void>((ok, fail) => {
        const out = createWriteStream(file, { flags: "a" });
        req.on("data", (c: Buffer) => {
          written += c.length;
          if (written > length) { req.destroy(); out.destroy(); fail(new HttpError(400, "too_long", "The chunk is longer than its range.")); }
        });
        req.on("error", fail);
        out.on("error", fail);
        out.on("finish", ok);
        req.pipe(out);
      });
      if (written !== length) throw new HttpError(400, "short_chunk", `Received ${written} of ${length} bytes; resend this chunk.`);
      db.prepare("UPDATE pub_uploads SET received_bytes = ?, attempts = attempts + 1, updated_at = ? WHERE artifact_id = ?").run(end + 1, now(), a.id);
      db.prepare("UPDATE pub_artifacts SET status = 'uploading' WHERE id = ?").run(a.id);
      return json(res, 200, { received: end + 1, size: a.size_bytes });
    } catch (e) {
      // A broken or partial chunk is cut off again, so the next attempt resumes exactly at the last good byte.
      if (existsSync(file)) truncateSync(file, up.received_bytes);
      db.prepare("UPDATE pub_uploads SET attempts = attempts + 1, updated_at = ? WHERE artifact_id = ?").run(now(), a.id);
      if (e instanceof HttpError) return errorJson(res, e.status, e.code, e.message);
      return errorJson(res, 400, "upload_interrupted", "The chunk was interrupted; resend it.");
    } finally {
      uploading.delete(a.id);
    }
  }

  async function hashFile(file: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
    return h.digest("hex");
  }

  async function complete(actor: Actor, a: ArtifactRow, res: ServerResponse) {
    const r = release(a.release_id)!;
    const up = db.prepare("SELECT * FROM pub_uploads WHERE artifact_id = ?").get(a.id) as { received_bytes: number; staging_key: string } | undefined;
    if (!up || r.status !== "draft") return errorJson(res, 409, "not_uploading", "This file is not waiting for an upload.");
    if (up.received_bytes !== a.size_bytes) return json(res, 409, { error: "incomplete", message: `Received ${up.received_bytes} of ${a.size_bytes} bytes.`, received: up.received_bytes });
    const staged = stagingPath(up.staging_key);
    const sha256 = await hashFile(staged);
    const problems: string[] = [];
    if (sha256 !== a.declared_sha256) problems.push(`SHA-256 mismatch: received ${sha256}, declared ${a.declared_sha256}. The file changed or was corrupted in transit.`);
    const content = problems.length ? null : inspectContent(staged, a.platform as PublishPlatform, a.format as PublishFormat);
    if (content) problems.push(...content.problems);
    if (content?.kind && a.declared_kind && content.kind !== a.declared_kind && content.kind !== "simulator-build") {
      problems.push(`Declared as a ${a.declared_kind}, but the file is a ${content.kind}.`);
    }
    const pkgDeclared = a.package ? (JSON.parse(a.package) as { id: string; version: string; architecture: string }) : null;
    const destinations = JSON.parse(r.destinations) as string[];
    if (content?.debian?.controlReadable && pkgDeclared) {
      if (content.debian.package !== pkgDeclared.id || content.debian.version !== pkgDeclared.version || content.debian.architecture !== pkgDeclared.architecture) {
        problems.push(`The package's control file says ${content.debian.package} ${content.debian.version} (${content.debian.architecture}), not what was declared.`);
      }
    }
    if (destinations.includes("hcg-repo") && a.format === "deb") {
      // Sileo asks authorize_download for the Debian version it saw in HCG Repo's index; the Store matches it against
      // the release version, so a package numbered differently could never be delivered.
      const debVersion = content?.debian?.controlReadable ? content.debian.version : pkgDeclared?.version;
      if (debVersion && !debianVersionMatches(debVersion, r.version)) {
        problems.push(`The package's Debian version is ${debVersion}, but the release is ${r.version}. Use ${r.version} or ${r.version}-<revision>.`);
      }
      const pkgId = content?.debian?.package ?? pkgDeclared?.id;
      const mapped = pkgId ? findByPackageId(registry, pkgId) : null;
      if (!pkgId) problems.push("HCG Repo needs the package identifier (control file or the uploading tool).");
      else if (!mapped || mapped.product.id !== r.product_id || (r.edition_id && mapped.edition.id !== r.edition_id)) {
        problems.push(`Package ${pkgId} is not mapped to ${r.product_id}${r.edition_id ? ` (${r.edition_id})` : ""} in the catalogue; HCG Repo would not deliver it.`);
      }
    }
    const validation = {
      sha256Matches: sha256 === a.declared_sha256, receivedSha256: sha256, content: content ?? null, problems,
      signatureStructure: content?.signature ?? "not-checked",
      note: "HCG Store checks the hash, the format and archive safety. Signature and notarisation results are reported by the uploading tool and are not verified by the Store.",
    };
    if (problems.length) {
      transaction(db, () => {
        db.prepare("UPDATE pub_artifacts SET status = 'rejected', sha256 = ?, validation = ?, completed_at = ? WHERE id = ?").run(sha256, JSON.stringify(validation), now(), a.id);
        db.prepare("DELETE FROM pub_uploads WHERE artifact_id = ?").run(a.id);
        audit(actor.sub, "artifact.rejected", r.id, a.id, { problems, sha256 });
      });
      rmSync(staged, { force: true });
      return json(res, 422, { error: "artifact_rejected", message: problems.join(" "), artifact: artifactView(artifact(a.id)!) });
    }
    const storageKey = `releases/${r.product_id}/${r.id}/${sha256.slice(0, 16)}/${a.file_name}`;
    const final = stagingPath(storageKey);
    if (existsSync(final)) throw new HttpError(409, "exists", "An immutable file already exists at this location.");
    mkdirSync(dirname(final), { recursive: true });
    renameSync(staged, final);
    chmodSync(final, 0o444);
    transaction(db, () => {
      db.prepare("UPDATE pub_artifacts SET status = 'verified', sha256 = ?, storage_key = ?, validation = ?, completed_at = ? WHERE id = ?")
        .run(sha256, storageKey, JSON.stringify(validation), now(), a.id);
      db.prepare("DELETE FROM pub_uploads WHERE artifact_id = ?").run(a.id);
      audit(actor.sub, "artifact.verified", r.id, a.id, { sha256, sizeBytes: statSync(final).size, kind: content?.kind, signatureStructure: validation.signatureStructure, ios: content?.ios });
    });
    return json(res, 200, { artifact: artifactView(artifact(a.id)!) });
  }

  // ------------------------------------------------------------- downloads

  type Decision = { ok: true; basis: string } | { ok: false; status: number; code: string; message: string };

  async function authorizeDownload(subject: Subject & { via?: Actor["via"] }, a: ArtifactRow): Promise<Decision> {
    const r = release(a.release_id);
    if (!r || a.status !== "verified") return { ok: false, status: 404, code: "not_found", message: "Not found." };
    if (r.status === "withdrawn") return { ok: false, status: 410, code: "withdrawn", message: "This release was withdrawn." };
    const actor: Actor = { sub: subject.sub, accessToken: subject.accessToken, via: subject.via ?? "web" };
    if (await permitted(actor, "publish", r.product_id)) return { ok: true, basis: "publisher" };
    // Draft review: the people HCG allows to approve this product may download it to check it before approving.
    if (await permitted(actor, "approve", r.product_id)) return { ok: true, basis: "approver-review" };
    if (r.status !== "approved" || !r.approved_eligibility || r.approved_eligibility === "private") {
      return { ok: false, status: 403, code: "not_released", message: "This release is not approved for you to download." };
    }
    if (!cfg.protectedDownloads) return { ok: false, status: 403, code: "downloads_not_available", message: "Downloads are not available yet." };
    const central = productInfo(r.product_id)?.centralId;
    if (r.approved_eligibility === "public" && r.distribution === "free") return { ok: true, basis: "public-free" };
    if (!central) return { ok: false, status: 403, code: "not_entitled", message: "This product has no confirmed central product ID, so no one can be entitled to it yet." };
    const edition = r.edition_id ? findProduct(registry, r.product_id)?.editions.find((e) => e.id === r.edition_id) : undefined;
    const check = await authority.check(subject, { centralProductId: central, editionId: r.edition_id, centralEditionKey: edition?.centralEditionKey ?? null });
    if (check.status === "unavailable") return { ok: false, status: 503, code: "hcg_unavailable", message: "Your access could not be checked right now." };
    if (check.status !== "granted") return { ok: false, status: 403, code: "not_entitled", message: "Your HCG account does not include this product." };
    return { ok: true, basis: r.approved_eligibility === "public" ? "entitlement" : "internal-testing-entitlement" };
  }

  // ------------------------------------------------------------- published releases for the Store's own delivery paths

  /** Verified files of releases MANUALLY approved for public delivery (used by /api/v1/downloads and Sileo). */
  function publishedFor(productId: string, editionId: string | null): ProtectedArtifact[] {
    if (!P.enabled) return [];
    const rows = db.prepare(
      `SELECT a.* FROM pub_artifacts a JOIN pub_releases r ON r.id = a.release_id
       WHERE r.product_id = ? AND r.edition_id IS ? AND r.status = 'approved' AND r.approved_eligibility = 'public' AND a.status = 'verified'`,
    ).all(productId, editionId) as ArtifactRow[];
    return rows.map((a) => asProtected(a, productId, editionId));
  }

  function freePublicFor(productId: string, editionId: string | null): ProtectedArtifact[] {
    if (!P.enabled) return [];
    const rows = db.prepare(
      `SELECT a.* FROM pub_artifacts a JOIN pub_releases r ON r.id = a.release_id
       WHERE r.product_id = ? AND r.edition_id IS ? AND r.status = 'approved' AND r.approved_eligibility = 'public'
         AND r.distribution = 'free' AND a.status = 'verified'`,
    ).all(productId, editionId) as ArtifactRow[];
    return rows.map((a) => asProtected(a, productId, editionId));
  }

  function asProtected(a: ArtifactRow, productId: string, editionId: string | null): ProtectedArtifact {
    return { id: a.id, productId, releaseId: a.release_id, catalogueArtifactId: a.id, editionId, fileName: a.file_name, contentType: a.content_type,
      sha256: a.sha256!, storageKey: a.storage_key!, deliveryApproved: true, testOnly: false };
  }

  function publishedById(id: string): ProtectedArtifact | undefined {
    const a = artifact(id);
    const r = a ? release(a.release_id) : undefined;
    if (!a || !r || r.status !== "approved" || r.approved_eligibility !== "public" || a.status !== "verified") return undefined;
    return asProtected(a, r.product_id, r.edition_id);
  }

  function publishedMeta(id: string): { version: string; architectures: string[] } | undefined {
    const a = artifact(id);
    const r = a ? release(a.release_id) : undefined;
    return a && r ? { version: r.version, architectures: JSON.parse(a.architectures) } : undefined;
  }

  // ------------------------------------------------------------- HCG Repo: approved and withdrawn packages

  /**
   * `GET /api/v1/repo/releases?destination=hcg-repo`: what HCG Repo may index, and what it must remove. Releases
   * approved for public delivery and releases withdrawn after such an approval, with each verified `.deb`'s SHA-256,
   * size, architectures and control fields. Metadata only: never a file or a download URL. Shown per product to the
   * people HCG lets publish or approve that product (no separate HCG Repo role exists centrally).
   */
  async function repoReleases(actor: Actor, url: URL) {
    if (url.searchParams.get("destination") !== "hcg-repo") throw new HttpError(400, "invalid_destination", "Use destination=hcg-repo.");
    const rows = (db.prepare("SELECT * FROM pub_releases WHERE approved_eligibility = 'public' AND status IN ('approved', 'withdrawn') ORDER BY approved_at").all() as ReleaseRow[])
      .filter((r) => (JSON.parse(r.destinations) as string[]).includes("hcg-repo"));
    const allowed = new Map<string, boolean>();
    const releases = [];
    for (const r of rows) {
      if (!allowed.has(r.product_id)) allowed.set(r.product_id, (await permitted(actor, "publish", r.product_id)) || (await permitted(actor, "approve", r.product_id)));
      if (!allowed.get(r.product_id)) continue;
      releases.push({
        id: r.id, productId: r.product_id, editionId: r.edition_id, version: r.version, build: r.build, channel: r.channel, distribution: r.distribution,
        status: r.status, approvedEligibility: r.approved_eligibility, approvedAt: r.approved_at,
        withdrawnAt: r.status === "withdrawn" ? r.updated_at : null, withdrawnReason: r.withdrawn_reason,
        artifacts: artifactsOf(r.id).filter((a) => a.status === "verified" && a.format === "deb").map((a) => {
          const v = artifactView(a);
          const control = (v.validation?.content as ContentReport | null | undefined)?.debian;
          const pkg = control?.controlReadable ? { id: control.package ?? null, version: control.version ?? null, architecture: control.architecture ?? null, source: "control-file" } : v.package ? { ...v.package, source: "declared" } : null;
          return { id: v.id, fileName: v.fileName, sha256: v.sha256, sizeBytes: v.sizeBytes, architectures: v.architectures, package: pkg, kind: v.kind };
        }),
      });
    }
    return { api_version: "v1", destination: "hcg-repo", generatedAt: now(), releases };
  }

  // ------------------------------------------------------------- router

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    try {
      return await routeInner(req, res, url);
    } catch (e) {
      if (e instanceof z.ZodError) {
        errorJson(res, 400, "invalid_request", e.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
        return true;
      }
      throw e;
    }
  }

  async function routeInner(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (!p.startsWith("/api/v1/publishing") && !p.startsWith("/publishing-upload/") && !p.startsWith("/publishing-download/") && !p.startsWith("/publishing/") && p !== "/api/v1/repo/releases") return false;
    if (!P.enabled) { errorJson(res, 404, "publishing_disabled", "Publishing is not enabled on this Store."); return true; }
    let match: RegExpExecArray | null;

    if ((match = /^\/publishing-upload\/v1\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(p)) && (m === "PUT" || m === "GET")) { await putChunk(req, res, match[1]!); return true; }
    if ((match = /^\/publishing-download\/v1\/([A-Za-z0-9_-]{20,})$/.exec(p)) && m === "GET") { await serveDownload(res, match[1]!); return true; }

    const actor = await actorOf(req);
    // Cookie-authenticated changes must come from the Store's own pages (CSRF); bearer calls carry no cookie.
    if (actor.via === "web" && m !== "GET") assertSameOrigin(req, cfg.publicOrigin);

    if (p === "/api/v1/repo/releases" && m === "GET") { send(json(res, 200, await repoReleases(actor, url))); return true; }

    if (p === "/api/v1/publishing/whoami" && m === "GET") {
      return send(json(res, 200, { sub: actor.sub, email: actor.email ?? null, via: actor.via, publisherPermission: P.publisherCentralId, approverPermission: P.approverCentralId, maxUploadBytes: P.maxUploadBytes, chunkBytes: P.chunkBytes }));
    }
    if (p === "/api/v1/publishing/products" && m === "GET") {
      const all = [
        ...registry.catalogue.products.map((x) => ({ id: x.id, title: x.name, source: "catalogue" as const, editions: x.editions.map((e) => ({ id: e.id, name: e.name, platforms: e.platforms })), centralId: x.registry.centralId, hcgRepo: x.hcgRepo.map((l) => l.key) })),
        ...(db.prepare("SELECT id, title FROM pub_products ORDER BY id").all() as { id: string; title: string }[]).map((d) => ({ id: d.id, title: d.title, source: "draft" as const, editions: [], centralId: null, hcgRepo: [] })),
      ];
      const allowed = [];
      for (const x of all) if (await permitted(actor, "publish", x.id)) allowed.push(x);
      return send(json(res, 200, { products: allowed }));
    }
    if (p === "/api/v1/publishing/products" && m === "POST") {
      const body = z.strictObject({ id: z.string().regex(kebab).max(60), title: text.max(120) }).parse(await readJson(req));
      await requirePermission(actor, "publish", "*");
      if (findProduct(registry, body.id) || productInfo(body.id)) throw new HttpError(409, "exists", "A product with this ID already exists.");
      transaction(db, () => {
        db.prepare("INSERT INTO pub_products (id, title, created_by, created_at) VALUES (?, ?, ?, ?)").run(body.id, body.title, actor.sub, now());
        audit(actor.sub, "product.draft-created", null, null, { productId: body.id, title: body.title });
      });
      return send(json(res, 201, { id: body.id, title: body.title, source: "draft", note: "A draft product exists only in HCG Store. Public release needs HCG to add it to the catalogue with a confirmed central product ID." }));
    }
    if (p === "/api/v1/publishing/releases" && m === "GET") {
      const productId = url.searchParams.get("productId") ?? "";
      await requirePermission(actor, "publish", productId);
      const rows = db.prepare("SELECT * FROM pub_releases WHERE product_id = ? ORDER BY created_at DESC").all(productId) as ReleaseRow[];
      return send(json(res, 200, { releases: rows.map((r) => releaseView(r, false)) }));
    }
    if (p === "/api/v1/publishing/releases" && m === "POST") {
      const input = ReleaseInput.parse(await readJson(req));
      const pinfo = productInfo(input.productId);
      if (!pinfo) throw new HttpError(404, "unknown_product", "Unknown product. Choose one from the Store or create a draft product.");
      await requirePermission(actor, "publish", input.productId);
      if (pinfo.editions.length ? !input.editionId || !pinfo.editions.includes(input.editionId) : input.editionId !== null) {
        throw new HttpError(400, "bad_edition", pinfo.editions.length ? `Choose an edition: ${pinfo.editions.join(", ")}.` : "This product has no editions.");
      }
      if (input.destinations.includes("hcg-repo") && pinfo.packageIds.length === 0) throw new HttpError(400, "no_repo_mapping", "This product has no HCG Repo package mapping in the catalogue.");
      const id = `rel-${randomBytes(8).toString("hex")}`;
      try {
        transaction(db, () => {
          db.prepare(`INSERT INTO pub_releases (id, product_id, product_source, edition_id, version, build, channel, release_notes, compatibility, distribution,
                      requested_eligibility, destinations, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?)`)
            .run(id, input.productId, pinfo.source, input.editionId, input.version, input.build, input.channel, JSON.stringify(input.releaseNotes),
                 JSON.stringify(input.compatibility), input.distribution, input.eligibility, JSON.stringify(input.destinations), actor.sub, now(), now());
          audit(actor.sub, "release.draft-created", id, null, { productId: input.productId, editionId: input.editionId, version: input.version, build: input.build, eligibility: input.eligibility, distribution: input.distribution, via: actor.via });
        });
      } catch (e) {
        if (!String((e as Error).message).includes("UNIQUE")) throw e;
        // Idempotent retry: the same person asking again for the same draft (e.g. the response was lost) gets the
        // existing draft back instead of a duplicate or an error. Anything else is a real conflict.
        const existing = db.prepare("SELECT * FROM pub_releases WHERE product_id = ? AND COALESCE(edition_id, '') = ? AND version = ? AND build = ?")
          .get(input.productId, input.editionId ?? "", input.version, input.build) as ReleaseRow | undefined;
        if (existing && existing.status === "draft" && existing.created_by === actor.sub) {
          const same = existing.channel === input.channel && existing.distribution === input.distribution && existing.requested_eligibility === input.eligibility
            && existing.destinations === JSON.stringify(input.destinations) && existing.release_notes === JSON.stringify(input.releaseNotes);
          if (same) return send(json(res, 200, { ...releaseView(existing), reused: true }));
          throw new HttpError(409, "draft_exists", `Your draft ${existing.id} already uses version ${input.version} build ${input.build} with different details. Continue that draft, or use a new build number.`);
        }
        throw new HttpError(409, "version_exists", `Version ${input.version} build ${input.build} already exists for this product${existing ? ` (${existing.status})` : ""}. Releases are immutable: use a new build number.`);
      }
      return send(json(res, 201, releaseView(release(id)!)));
    }
    if ((match = /^\/api\/v1\/publishing\/releases\/(rel-[a-f0-9]{16})(\/[a-z-]+)?$/.exec(p))) {
      const r = release(match[1]!);
      if (!r) throw new HttpError(404, "not_found", "Not found.");
      const action = match[2] ?? "";
      if (action === "" && m === "GET") {
        if (!(await permitted(actor, "publish", r.product_id)) && !(await permitted(actor, "approve", r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        return send(json(res, 200, { ...releaseView(r), auditIntact: auditIntact() }));
      }
      if (action === "/artifacts" && m === "POST") {
        await requirePermission(actor, "publish", r.product_id);
        if (r.status !== "draft") throw new HttpError(409, "release_locked", "Files can be added only to a draft release.");
        const input = ArtifactInput.parse(await readJson(req));
        const problems = checkDeclaration({ fileName: input.fileName, platform: input.platform, format: input.format, sizeBytes: input.sizeBytes, maxBytes: P.maxUploadBytes });
        const destinations = JSON.parse(r.destinations) as string[];
        if (destinations.includes("hcg-repo") && input.format === "deb" && !input.package) problems.push("For HCG Repo, send the package identifier, version and architecture from the control file.");
        if (destinations.includes("hcg-repo") && input.format === "deb" && input.package && !debianVersionMatches(input.package.version, r.version)) {
          problems.push(`The package's Debian version is ${input.package.version}, but the release is ${r.version}. Use ${r.version} or ${r.version}-<revision>.`);
        }
        if (input.kind === "simulator-build") {
          problems.push("HCG Store does not accept iOS Simulator builds: they run only in the Simulator on a Mac and cannot be installed on an iPhone or iPad. Ship a device build (IPA) or a jailbreak package.");
        } else if (input.kind) {
          const expected = kindFromFormat(input.platform, input.format);
          if (expected && input.kind !== expected) problems.push(`A ${input.platform} ${input.format} is a ${expected}, not a ${input.kind}.`);
        }
        if (problems.length) throw new HttpError(400, "artifact_refused", problems.join(" "));
        const id = `art-${randomBytes(8).toString("hex")}`;
        try {
          transaction(db, () => {
            db.prepare(`INSERT INTO pub_artifacts (id, release_id, file_name, platform, format, architectures, minimum_os, size_bytes, declared_sha256, status,
                        content_type, signing_reported, package, created_at, declared_kind) VALUES (?,?,?,?,?,?,?,?,?, 'awaiting-upload', ?, ?, ?, ?, ?)`)
              .run(id, r.id, input.fileName, input.platform, input.format, JSON.stringify(input.architectures), input.minimumOs, input.sizeBytes, input.sha256,
                   CONTENT_TYPES[input.format], JSON.stringify({ ...input.signing, reportedBy: actor.via }), input.package ? JSON.stringify(input.package) : null, now(), input.kind);
            db.prepare("INSERT INTO pub_uploads (artifact_id, received_bytes, staging_key, attempts, updated_at) VALUES (?, 0, ?, 0, ?)").run(id, `.uploads/${id}.part`, now());
            audit(actor.sub, "artifact.declared", r.id, id, { fileName: input.fileName, platform: input.platform, format: input.format, kind: input.kind, sizeBytes: input.sizeBytes, declaredSha256: input.sha256, signing: input.signing });
          });
        } catch (e) {
          if (String((e as Error).message).includes("UNIQUE")) throw new HttpError(409, "file_exists", `${input.fileName} is already part of this release.`);
          throw e;
        }
        return send(json(res, 201, { artifact: artifactView(artifact(id)!), ...uploadUrl(id, actor.sub) }));
      }
      if (action === "/submit" && m === "POST") {
        await requirePermission(actor, "publish", r.product_id);
        if (r.status !== "draft") throw new HttpError(409, "not_draft", "Only a draft can be submitted.");
        const arts = artifactsOf(r.id);
        if (!arts.some((a) => a.status === "verified")) throw new HttpError(409, "no_files", "Upload and verify at least one file first.");
        if (arts.some((a) => ["awaiting-upload", "uploading"].includes(a.status))) throw new HttpError(409, "uploads_pending", "Finish or remove the uploads in progress first.");
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
          audit(actor.sub, "release.submitted", r.id, null, { files: arts.filter((a) => a.status === "verified").map((a) => ({ id: a.id, sha256: a.sha256 })) });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if (action === "/approve" && m === "POST") {
        // Manual approval happens in HCG Store, signed in through the browser; a desktop token cannot approve.
        if (actor.via !== "web") throw new HttpError(403, "manual_approval_required", "Releases are approved manually in HCG Store, not from a desktop app.");
        await requirePermission(actor, "approve", r.product_id);
        // `current`: the approver also makes this the product's current release in the public catalogue (generated
        // from these records by `npm run releases:sync`; never inferred from the newest version).
        const body = z.strictObject({ eligibility: z.enum(["private", "internal-testing", "public"]), confirm: z.string(), current: z.boolean().default(false) }).parse(await readJson(req));
        if (body.current && body.eligibility !== "public") throw new HttpError(400, "current_needs_public", "Only a release approved for public delivery can be the catalogue's current release.");
        if (!["submitted", "approved"].includes(r.status)) throw new HttpError(409, "not_submitted", "Only a submitted release can be approved.");
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        if (ELIGIBILITY_RANK[body.eligibility] > ELIGIBILITY_RANK[r.requested_eligibility as keyof typeof ELIGIBILITY_RANK]) throw new HttpError(400, "beyond_request", "Approval cannot exceed the eligibility the publisher requested.");
        if (body.eligibility === "public") {
          if (r.created_by === actor.sub) throw new HttpError(403, "separation_of_duties", "Public release needs an approver other than the person who created it.");
          if (productInfo(r.product_id)?.source !== "catalogue" || !productInfo(r.product_id)?.centralId) {
            throw new HttpError(409, "not_in_catalogue", "Public release needs the product in HCG's catalogue with a confirmed central product ID.");
          }
          const notInstallable = artifactsOf(r.id).filter((a) => a.status === "verified").map(artifactView)
            .filter((a) => a.kind === "device-build" && ["unsigned", "not-installable"].includes(a.readiness.status));
          if (notInstallable.length) {
            throw new HttpError(409, "not_installable", `Public release refused: ${notInstallable.map((a) => a.fileName).join(", ")} cannot be installed on an iPhone or iPad (${notInstallable[0]!.readiness.label}) Approve it for private or internal testing, or ship a signed build.`);
          }
        }
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'approved', approved_eligibility = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(body.eligibility, actor.sub, now(), now(), r.id);
          audit(actor.sub, "release.approved", r.id, null, { eligibility: body.eligibility, current: body.current });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if (action === "/withdraw" && m === "POST") {
        if (!(await permitted(actor, "publish", r.product_id)) && !(await permitted(actor, "approve", r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        const body = z.strictObject({ reason: text.max(500) }).parse(await readJson(req));
        if (r.status === "withdrawn") throw new HttpError(409, "already_withdrawn", "Already withdrawn.");
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE id = ?").run(body.reason, now(), r.id);
          audit(actor.sub, "release.withdrawn", r.id, null, { reason: body.reason, previousStatus: r.status, previousEligibility: r.approved_eligibility });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
    }
    if ((match = /^\/api\/v1\/publishing\/artifacts\/(art-[a-f0-9]{16})(\/[a-z-]+)?$/.exec(p))) {
      const a = artifact(match[1]!);
      const r = a ? release(a.release_id) : undefined;
      if (!a || !r) throw new HttpError(404, "not_found", "Not found.");
      const action = match[2] ?? "";
      if (action === "/download-url" && m === "POST") {
        const d = await authorizeDownload({ sub: actor.sub, accessToken: actor.accessToken, via: actor.via }, a);
        if (!d.ok) throw new HttpError(d.status, d.code, d.message);
        const token = randomToken(32);
        const exp = now() + cfg.downloadUrlTtlSeconds * 1000;
        db.prepare("INSERT INTO pub_download_grants (id_hash, sub, artifact_id, access_token, expires_at) VALUES (?, ?, ?, ?, ?)")
          .run(sha256Hex(token), actor.sub, a.id, actor.accessToken ? seal(cfg.secretKey, actor.accessToken, "pub-download") : null, exp);
        return send(json(res, 200, { url: `${cfg.publicOrigin}/publishing-download/v1/${token}`, expiresAt: exp, sha256: a.sha256, basis: d.basis }));
      }
      await requirePermission(actor, "publish", r.product_id);
      if (action === "/upload-url" && m === "POST") {
        if (!["awaiting-upload", "uploading"].includes(a.status) || r.status !== "draft") throw new HttpError(409, "not_uploading", "This file is not waiting for an upload.");
        const up = db.prepare("SELECT received_bytes FROM pub_uploads WHERE artifact_id = ?").get(a.id) as { received_bytes: number };
        return send(json(res, 200, { received: up.received_bytes, ...uploadUrl(a.id, actor.sub) }));
      }
      if (action === "/complete" && m === "POST") { await complete(actor, a, res); return true; }
      if (action === "" && m === "DELETE") {
        if (r.status !== "draft") throw new HttpError(409, "release_locked", "Files can be removed only from a draft. Withdraw the release instead.");
        if (a.status === "verified") {
          transaction(db, () => {
            db.prepare("UPDATE pub_artifacts SET status = 'removed' WHERE id = ?").run(a.id);
            audit(actor.sub, "artifact.removed", r.id, a.id, { sha256: a.sha256, note: "The stored file is kept (immutable); it is no longer part of the draft." });
          });
        } else {
          const up = db.prepare("SELECT staging_key FROM pub_uploads WHERE artifact_id = ?").get(a.id) as { staging_key: string } | undefined;
          if (up) rmSync(stagingPath(up.staging_key), { force: true });
          transaction(db, () => {
            db.prepare("DELETE FROM pub_uploads WHERE artifact_id = ?").run(a.id);
            db.prepare("DELETE FROM pub_artifacts WHERE id = ?").run(a.id);
            audit(actor.sub, "artifact.aborted", r.id, a.id, { previousStatus: a.status, fileName: a.file_name });
          });
        }
        return send(json(res, 200, releaseView(release(r.id)!, false)));
      }
    }
    if ((match = /^\/publishing\/releases\/(rel-[a-f0-9]{16})$/.exec(p)) && m === "GET") {
      const r = release(match[1]!);
      if (!r || (!(await permitted(actor, "publish", r.product_id)) && !(await permitted(actor, "approve", r.product_id)))) throw new HttpError(404, "not_found", "Not found.");
      return send(reviewPage(res, releaseView(r), await permitted(actor, "approve", r.product_id)));
    }
    throw new HttpError(404, "not_found", "Not found.");

    function send(_: void) { return true; }
  }

  async function serveDownload(res: ServerResponse, token: string) {
    const g = db.prepare("SELECT * FROM pub_download_grants WHERE id_hash = ?").get(sha256Hex(token)) as { sub: string; artifact_id: string; access_token: string | null; expires_at: number } | undefined;
    if (!g || g.expires_at < now()) return errorJson(res, 403, "link_expired", "This download link has expired.");
    const a = artifact(g.artifact_id);
    if (!a) return errorJson(res, 404, "not_found", "Not found.");
    // Re-checked at use: a withdrawal or a revoked entitlement applies even inside the link's lifetime.
    const d = await authorizeDownload({ sub: g.sub, accessToken: g.access_token ? unseal(cfg.secretKey, g.access_token, "pub-download") : null }, a);
    if (!d.ok) return errorJson(res, d.status, d.code, d.message);
    audit(g.sub, "artifact.downloaded", a.release_id, a.id, { basis: d.basis });
    return deps.streamArtifact(res, a.storage_key!, a.file_name, a.content_type);
  }

  function reviewPage(res: ServerResponse, r: ReturnType<typeof releaseView>, canApprove: boolean) {
    const e = escapeHtml;
    const kindName: Record<string, string> = { installer: "Installer", "portable-app": "Portable app", "device-build": "iOS device build", "simulator-build": "iOS Simulator build", "jailbreak-package": "Jailbreak package" };
    const rows = r.artifacts.map((a) => `<tr><td>${e(a.fileName)}</td><td>${e(a.platform)} · ${e(a.format)}</td><td>${e(kindName[a.kind ?? ""] ?? "—")}${a.kindCheckedByStore ? "" : " (declared)"}</td><td>${a.sizeBytes}</td><td><code>${e(a.sha256 ?? a.declaredSha256)}</code></td><td>${e(a.status)}</td><td>${e(a.validation?.signatureStructure ?? "—")} / reported: ${e(a.signingReported.status)}</td><td class="${a.readiness.ordinaryInstall ? "ok" : "warn"}">${e(a.readiness.label)}</td><td>${a.status === "verified" && r.status !== "withdrawn" ? `<button class="dl" data-id="${e(a.id)}">Download to review</button>` : ""}</td></tr>`).join("");
    const download = `<script>document.querySelectorAll('button.dl').forEach(b=>b.onclick=async()=>{const r=await fetch('/api/v1/publishing/artifacts/'+b.dataset.id+'/download-url',{method:'POST'});const j=await r.json();if(r.ok)location.href=j.url;else alert(j.message);});</script>`;
    const approve = canApprove && ["submitted", "approved"].includes(r.status)
      ? `<form id="approve"><p>Manual approval. Requested: <b>${e(r.requestedEligibility)}</b>.</p><select name="eligibility"><option>private</option><option>internal-testing</option><option>public</option></select>
         <label><input type="checkbox" name="current"> Public only: make this the product's current release in the catalogue</label>
         <label>Type the version to confirm <input name="confirm" autocomplete="off"></label><button>Approve</button></form>
         <script>document.getElementById('approve').onsubmit=async(ev)=>{ev.preventDefault();const f=new FormData(ev.target);const r=await fetch(location.pathname.replace('/publishing/','/api/v1/publishing/')+'/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eligibility:f.get('eligibility'),confirm:f.get('confirm'),current:f.get('current')==='on'})});const j=await r.json();alert(r.ok?'Approved: '+j.approvedEligibility:j.message);location.reload();};</script>`
      : "";
    return html(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Release review · HCG Store</title>
      <style>body{font:15px system-ui;margin:2rem;max-width:72rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;font-size:13px}code{font-size:12px}.ok{color:#176b2c}.warn{color:#8a4b00}</style></head><body>
      <h1>${e(r.productTitle)} ${e(r.version)} (build ${e(r.build)})</h1>
      <p>Status: <b>${e(r.status)}</b>${r.approvedEligibility ? ` · approved for <b>${e(r.approvedEligibility)}</b>` : ""} · requested: ${e(r.requestedEligibility)} · distribution: ${e(r.distribution)} · channel: ${e(r.channel)} · destinations: ${e(r.destinations.join(", "))}${r.productSource === "draft" ? " · <b>draft product</b> (not in the catalogue)" : ""}</p>
      ${r.withdrawnReason ? `<p>Withdrawn: ${e(r.withdrawnReason)}</p>` : ""}
      <h2>Release notes</h2><ul>${r.releaseNotes.map((n: string) => `<li>${e(n)}</li>`).join("")}</ul>
      <h2>Compatibility</h2><pre>${e(JSON.stringify(r.compatibility, null, 2))}</pre>
      <h2>Files</h2><table><tr><th>File</th><th>Platform</th><th>Kind</th><th>Bytes</th><th>SHA-256</th><th>Status</th><th>Signature (structure / reported)</th><th>Installation</th><th></th></tr>${rows}</table>
      <p>Signature and notarisation results are reported by the uploading tool; HCG Store checks hashes, formats and archive safety only. A draft is visible only to the people HCG allows to publish or approve this product; uploading never makes a file public.</p>${download}
      ${approve}
      <h2>Audit</h2><ol>${(r.audit ?? []).map((a) => `<li>${new Date(a.at).toISOString()} · ${e(a.action)} · ${e(a.actor)}</li>`).join("")}</ol>
      </body></html>`);
  }

  return { route, publishedFor, freePublicFor, publishedById, publishedMeta, auditIntact, allowedFormats: ALLOWED };
}
