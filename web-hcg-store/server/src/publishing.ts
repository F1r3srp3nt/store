/**
 * Ship to Store: release publishing for HCG Executable Maker (and the Store's own review page).
 *
 *   GET    /api/v1/publishing/whoami                         who is calling; publisher/approver per HCG
 *   GET    /api/v1/publishing/capabilities                   API version, upload limits, formats, storage use (HCG Store Manager)
 *   GET    /api/v1/publishing/offers/windows?productId=      free testing periods and their history
 *   POST   /api/v1/publishing/offers/windows                 open a free testing period (fixed, or from publication)
 *   POST   /api/v1/publishing/offers/windows/:id/extend      longer / later end
 *   POST   /api/v1/publishing/offers/windows/:id/terminate   end now, with a reason
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
 *   POST   /api/v1/publishing/artifacts/:id/passport         attach an HCG Release Passport that matches the stored file exactly
 *   DELETE /api/v1/publishing/artifacts/:id                  abort an upload / remove a file from a draft
 *   POST   /api/v1/publishing/releases/:id/submit            submit for manual review
 *   POST   /api/v1/publishing/releases/:id/approve           MANUAL approval in the Store (web session only)
 *   POST   /api/v1/publishing/releases/:id/publish           explicit publication of an approved public release (web only,
 *                                                             not the creator); optionally supersedes the edition's
 *                                                             published releases. Nothing is delivered before this.
 *   POST   /api/v1/publishing/releases/:id/verify-checksums  re-hash the stored files against their recorded SHA-256
 *   GET    /api/v1/publishing/manager                        Release Manager: releases of every product you may publish/approve
 *   GET    /api/v1/publishing/compare?from=&to=              differences between two releases of one product
 *   POST   /api/v1/publishing/releases/:id/withdraw          stop delivery and end the review track, keep files and history
 *   POST   /api/v1/publishing/releases/:id/{disable,enable,archive,revoke}   availability (release-lifecycle.ts)
 *   POST   /api/v1/publishing/releases/:id/{supersede,restore}               current release per target (browser only)
 *   POST   /api/v1/publishing/releases/:id/requests          record a request (disable, enable, restore, supersede,
 *                                                             make current) for the people who approve and publish
 *   GET    /api/v1/publishing/me · /changes · /products/:id  permissions, change feed, product detail (PATCH: drafts)
 *   Full contract: docs/ADMINISTRATION.md §5.
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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { ALLOWED, checkDeclaration, CONTENT_TYPES, FORMATS, inspectContent, installReadiness, kindFromFormat, KINDS, PLATFORMS, STAFF_ONLY_FORMATS, type ArtifactKind, type ContentReport, type PublishFormat, type PublishPlatform } from "./artifact-validation";
import type { StoreConfig } from "./config";
import { seal, sha256Hex, signPayload, unseal, verifyPayload, randomToken } from "./crypto";
import { transaction, type Db } from "./db";
import { appendPubAudit, auditChainIntact } from "./release-records";
import { artifactIsCurrent, clearCurrent, currentRowsForProduct, currentTargetsOfRelease, lifecycleOf, switchCurrent, targetsOf, type SwitchResult } from "./release-lifecycle";
import { extendWindow, FreeWindowError, listWindows, openWindow, openWindowFor, terminateWindow, type FreeWindow, type WindowPeriod } from "./free-windows";
import { activeException, artifactSetDigest, exceptionsFor, grantFounderException, ReleaseExceptionError } from "./release-exceptions";
import type { EntitlementAuthority, Subject } from "./entitlements";
import type { HcgConnectClient } from "./hcg-connect";
import { assertSameOrigin, errorJson, escapeHtml, html, HttpError, json, readJson } from "./http";
import { findByPackageId, findProduct, type ProtectedArtifact, type Registry, type PublishedFileMeta } from "./registry";
import type { Session } from "./sessions";
import { isSemver } from "../../src/domain/version";
import { BUILD_PROVIDER_IDS } from "../../src/domain/taxonomy";
import { REJECTED_SHA256 } from "./release-import-request";

export interface Actor {
  sub: string;
  accessToken: string | null;
  /** "web": Store session in a browser; "desktop": bearer token from an allow-listed HCG Connect client. */
  via: "web" | "desktop";
  email?: string | null;
  /** Desktop: the HCG Connect client the token was issued to (recorded as the upload source). */
  clientId?: string | null;
  /** Web: the CSRF token bound to this Store session (sent back in X-HCG-CSRF on every change). */
  csrf?: string;
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
  /** Known limitations, shown with the release (e.g. not code-signed, features not yet verified on this platform). */
  knownLimitations: z.array(text).max(30).default([]),
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
  /**
   * Prepared now, applied only at publication: once this release is published, it replaces the current release of
   * each target it serves (same product, edition, platform, architecture and channel), and the replaced releases that
   * are then current nowhere become superseded. Until publication succeeds, the previous release stays current.
   */
  supersedePreviousOnPublish: z.boolean().default(false),
  /**
   * Distribution Studio (HCG Executable Maker): what the submitter asks the publisher to do at publication. Recorded
   * with the draft; nothing happens before publication. supersedePrevious "compatible" = supersedePreviousOnPublish
   * (replace the current release of the same product, edition, platform, architecture and channel only). makeCurrent
   * pre-selects "make this the catalogue's current release" for the approver and publisher.
   */
  publicationRequest: z.strictObject({
    makeCurrent: z.boolean().default(false),
    supersedePrevious: z.enum(["none", "compatible"]).default("none"),
    note: z.string().trim().max(500).optional(),
  }).optional(),
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
  /**
   * Build provenance, as REPORTED by the uploading tool (Executable Maker, CI). Optional while the release is a draft,
   * required on every file before it can be submitted for approval. The source repository is never asked for, so a
   * private repository stays private.
   */
  sourceCommit: z.string().regex(/^[a-f0-9]{7,40}$/, "The source commit must be a 7–40 character lowercase hex commit hash.").nullable().default(null),
  buildProvider: z.enum(BUILD_PROVIDER_IDS).nullable().default(null),
  toolchain: z.string().trim().min(1).max(200).nullable().default(null),
  /** The uploading tool's own validation (codesign, apksigner, Executable Maker checks). HCG Store adds its own. */
  validationReport: z.strictObject({ tool: z.string().trim().min(1).max(200), passed: z.boolean(), summary: z.string().trim().max(4000) }).nullable().default(null),
  /** A file of this release that the new one replaces. The replaced file is kept (immutable) but leaves the release. */
  replaces: z.string().regex(/^art-[a-f0-9]{16}$/).nullable().default(null),
});

const httpsUrl = z.string().trim().max(500).regex(/^https:\/\/[^\s<>"']+$/, "Use an https:// address.");
/**
 * Metadata of a Store DRAFT product (Product Manager). It lives only in HCG Store until HCG registers the product
 * centrally and it is added to the catalogue; it never creates a central product, an entitlement or a price.
 */
export const DraftProductMetadata = z.strictObject({
  title: text.max(120),
  summary: z.string().trim().max(300).default(""),
  description: z.array(text).max(30).default([]),
  categories: z.array(z.string().regex(kebab).max(40)).max(8).default([]),
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
  editions: z.array(z.strictObject({ id: z.string().regex(kebab).max(40), name: text.max(80) })).max(12).default([]),
  systemRequirements: z.array(z.strictObject({ platform: z.enum(PLATFORMS), minimumOs: z.string().trim().max(40).nullable().default(null), notes: z.array(text.max(300)).max(10).default([]) })).max(PLATFORMS.length).default([]),
  documentationUrl: httpsUrl.nullable().default(null),
  supportUrl: httpsUrl.nullable().default(null),
  /** Draft products are never public: "private" (publishers and approvers only) or "internal" (shown in admin lists to testers' managers). */
  visibility: z.enum(["private", "internal"]).default("private"),
});
export type DraftProductMetadata = z.infer<typeof DraftProductMetadata>;

/** Release states in which files can change. Changing a file of a submitted or approved release invalidates it. */
const OPEN_FOR_FILES = new Set(["draft", "submitted", "approved"]);

type ReleaseRow = {
  id: string; product_id: string; product_source: "catalogue" | "draft"; edition_id: string | null; version: string; build: string; channel: string;
  release_notes: string; compatibility: string; distribution: string; requested_eligibility: string; destinations: string; status: string;
  approved_eligibility: string | null; created_by: string; created_at: number; updated_at: number; submitted_at: number | null;
  approved_by: string | null; approved_at: number | null; withdrawn_reason: string | null;
  published_at: number | null; published_by: string | null; superseded_by: string | null;
  known_limitations: string; imported_from: string | null;
  availability: string; availability_reason: string | null; revision: number; supersede_on_publish: number; upload_source: string | null;
  publication_request: string | null;
};
type ArtifactRow = {
  id: string; release_id: string; file_name: string; platform: string; format: string; architectures: string; minimum_os: string | null;
  size_bytes: number; declared_sha256: string; sha256: string | null; status: string; storage_key: string | null; content_type: string;
  validation: string | null; signing_reported: string; package: string | null; created_at: number; completed_at: number | null;
  declared_kind: string | null; provenance: string | null;
};

type Provenance = { sourceCommit: string | null; buildProvider: string | null; toolchain: string | null; validationReport: { tool: string; passed: boolean; summary: string } | null };

const ELIGIBILITY_RANK = { private: 0, "internal-testing": 1, public: 2 } as const;

export function createPublishing(deps: PublishingDeps) {
  const { cfg, db, registry, authority, now } = deps;
  const P = cfg.publishing;
  const storageRoot = resolve(cfg.artifactStorageDir || ".");
  const uploading = new Set<string>();

  // ------------------------------------------------------------- audit (append-only, hash-chained)

  function audit(actor: string, action: string, releaseId: string | null, artifactId: string | null, detail: object) {
    appendPubAudit(db, now(), actor, action, releaseId, artifactId, detail);
  }

  /** Anyone HCG lets submit, approve or publish this product may read its releases and review page. */
  async function mayReview(actor: Actor, productId: string) {
    return (await permitted(actor, "publish", productId)) || (await permitted(actor, "approve", productId)) || (await permitted(actor, "publication", productId));
  }

  /** Who submitted the release for approval (the latest submission), from the audit chain. */
  function submitterOf(releaseId: string): string | null {
    return (db.prepare("SELECT actor FROM pub_audit WHERE action = 'release.submitted' AND release_id = ? ORDER BY seq DESC LIMIT 1").get(releaseId) as { actor: string } | undefined)?.actor ?? null;
  }
  const isSameParty = (r: { id: string; created_by: string }, sub: string) => r.created_by === sub || submitterOf(r.id) === sub;

  /**
   * Separation of duties for public approval and publication: the person acting is neither the release's creator nor
   * the person who submitted it. A CI build that created an imported release does not count as anyone: whoever
   * submitted it is the party. The only way past this is a founder-operated exception recorded for this exact release
   * and these exact files (release-exceptions.ts); its use is returned so it is written to the audit.
   */
  function separationOrException(r: { id: string; created_by: string }, sub: string, step: "approve" | "publish") {
    if (!isSameParty(r, sub)) return null;
    const ex = activeException(db, r.id, sub);
    if (ex) return ex;
    throw new HttpError(403, "separation_of_duties", step === "approve"
      ? "Public release needs an approver other than the person who created or submitted it (or a founder-operated exception recorded for this exact release)."
      : "Publication needs a person other than the one who created or submitted the release (or a founder-operated exception recorded for this exact release).");
  }

  /**
   * Mandatory signing for public delivery, which no exception changes: every macOS file customers would receive must be
   * Developer ID signed and notarized (Gatekeeper blocks anything else on other Macs), and every iOS/Android device
   * build must be installable. Returns the problems (empty: none).
   */
  function publicSigningProblems(releaseId: string): string[] {
    const out: string[] = [];
    for (const a of artifactsOf(releaseId).filter((x) => x.status === "verified" && !STAFF_ONLY_FORMATS.has(x.format)).map(artifactView)) {
      if (a.platform === "macos" && a.readiness.status !== "ready") out.push(`${a.fileName}: ${a.readiness.label} Public macOS files must be Developer ID signed and notarized.`);
      if ((a.kind === "device-build" || a.kind === "android-app") && ["unsigned", "not-installable"].includes(a.readiness.status)) out.push(`${a.fileName}: ${a.readiness.label}`);
    }
    return out;
  }

  /**
   * Whether HCG itself confirms this account as the Founder for HCG Store: /me reports the Founder policy
   * (founder_owner_all_products) and /access reports HCG Store as founder-owned under it. Never inferred from an e-mail
   * address, a Store profile or anything the client sends.
   */
  async function centralFounder(actor: Actor): Promise<{ confirmed: boolean; displayName: string | null; unavailable?: string }> {
    const a = await authority.accountAccess({ sub: actor.sub, accessToken: actor.accessToken }, [STORE_CENTRAL_PRODUCT_ID]);
    if (a.status !== "ok") return { confirmed: false, displayName: null, unavailable: a.reason };
    const store = a.products.find((x) => x.centralProductId === STORE_CENTRAL_PRODUCT_ID);
    return { confirmed: a.founderPolicy && store?.kind === "founder_owner", displayName: a.displayName };
  }

  type Gate = { allowed: boolean; reasons: string[]; resolution: { action: string; label: string } | null };
  const gate = (reasons: string[], resolution: Gate["resolution"] = null): Gate => ({ allowed: reasons.length === 0, reasons, resolution: reasons.length ? resolution : null });

  /**
   * Release Readiness Inspector: for this person and this release, what is ready, what is missing, and for each step
   * (submit, founder exception, approve, publish, reject, request changes, edit) whether it is allowed now and, if not,
   * exactly why and what resolves it. Computed from the same rules the actions enforce; the actions check again.
   */
  async function readiness(r: ReleaseRow, actor: Actor) {
    const may = { submit: await permitted(actor, "publish", r.product_id), approve: await permitted(actor, "approve", r.product_id), publication: await permitted(actor, "publication", r.product_id) };
    const arts = artifactsOf(r.id).filter((a) => a.status !== "removed");
    const views = arts.map(artifactView);
    const verified = views.filter((a) => a.status === "verified");
    const pending = views.filter((a) => ["awaiting-upload", "uploading"].includes(a.status));
    const rejected = views.filter((a) => a.status === "rejected");
    const notes = JSON.parse(r.release_notes) as string[];
    const provenanceMissing = verified.filter((a) => a.provenance?.buildProvider !== "manual-upload" && (!a.provenance?.sourceCommit || !a.provenance?.buildProvider || !a.provenance?.toolchain));
    const signing = publicSigningProblems(r.id);
    const sameParty = isSameParty(r, actor.sub);
    const exception = activeException(db, r.id, actor.sub);
    const open = ["draft", "submitted", "approved"].includes(r.status);
    const founder = sameParty && !exception && open && verified.length ? await centralFounder(actor) : null;
    const publicRequested = r.requested_eligibility === "public";
    const separation = (step: string) => (sameParty && !exception && publicRequested ? [`You created or submitted this release, so ${step} for public delivery needs another person with the permission, or a founder-operated exception recorded for this exact release and these files.`] : []);
    const centralOk = productInfo(r.product_id)?.source === "catalogue" && !!productInfo(r.product_id)?.centralId;
    const pubOn = P.publicationEnabled && publicationOn(r.product_id);

    const submit = gate([
      ...(!may.submit ? [`HCG has not granted your account ${P.publisherCentralId} for HCG Store.`] : []),
      ...(r.status !== "draft" ? [`The release is ${r.status}; only a draft is submitted.`] : []),
      ...(r.status === "draft" && !verified.length ? ["No verified file yet: upload at least one file and let HCG Store verify it."] : []),
      ...(r.status === "draft" && pending.length ? [`Uploads in progress: ${pending.map((a) => a.fileName).join(", ")}. Finish or remove them.`] : []),
      ...(r.status === "draft" && !notes.length ? ["Release notes are empty."] : []),
      ...(r.status === "draft" && provenanceMissing.length ? [`Build provenance (source commit, build provider, toolchain) is missing for ${provenanceMissing.map((a) => a.fileName).join(", ")}; upload them again with it, or as a manual upload.`] : []),
      ...(r.imported_from && actor.via !== "web" ? ["An imported release is submitted in the browser."] : []),
    ], r.status === "draft" && !notes.length ? { action: "edit", label: "Add release notes" } : r.status === "draft" && !verified.length ? { action: "upload", label: "Upload files" } : null);

    const founderGate = gate([
      ...(P.founderWebExceptions === "off" ? ["Founder exceptions on the website are switched off on this Store (HCG_STORE_FOUNDER_WEB_EXCEPTIONS=off)."] : []),
      ...(!sameParty ? ["Not needed: you neither created nor submitted this release, so you may approve or publish it normally."] : []),
      ...(exception ? [`Already recorded (${exception.id}) for these exact files.`] : []),
      ...(!open ? [`The release is ${r.status}; an exception is only for a release not yet published.`] : []),
      ...(open && !verified.length ? ["The release has no verified files to bind the exception to."] : []),
      ...(pending.length ? ["Uploads are still in progress."] : []),
      ...(!(may.submit && may.approve && may.publication) ? ["HCG must grant you store.publish, store.release.approve and store.release.publish for HCG Store."] : []),
      ...(founder?.unavailable ? [`HCG could not confirm the Founder policy right now (${founder.unavailable}). Try again shortly.`] : []),
      ...(founder && !founder.unavailable && !founder.confirmed ? ["HCG does not confirm the Founder policy (founder_owner_all_products) for your account and HCG Store, so you cannot record a founder exception. Ask another person to approve."] : []),
      ...(publicRequested && signing.length ? ["The files do not meet the mandatory signing requirements for public delivery; an exception never changes them.", ...signing] : []),
      ...(actor.via !== "web" ? ["A founder exception is recorded in the browser."] : []),
    ]);

    const approve = gate([
      ...(!pubOn ? ["Approval and publication are switched off for this product on this Store."] : []),
      ...(!may.approve ? [`HCG has not granted your account ${P.approverCentralId} for HCG Store.`] : []),
      ...(r.status !== "submitted" && r.status !== "approved" ? [r.status === "draft" ? "The release is a draft: submit it for review first." : `The release is ${r.status}.`] : []),
      ...(actor.via !== "web" ? ["Releases are approved in the browser."] : []),
      ...separation("approval"),
      ...(publicRequested && signing.length ? signing : []),
      ...(publicRequested && !centralOk ? ["Public release needs the product in HCG's catalogue with a confirmed central product ID."] : []),
    ], r.status === "draft" && submit.allowed ? { action: "submit", label: "Submit for review" } : sameParty && !exception && publicRequested && founderGate.allowed ? { action: "founder-exception", label: "Record founder exception" } : null);

    const publish = gate([
      ...(!pubOn ? ["Approval and publication are switched off for this product on this Store."] : []),
      ...(!may.publication ? [`HCG has not granted your account ${P.publicationCentralId} for HCG Store.`] : []),
      ...(r.status !== "approved" ? [r.status === "published" ? "Already published." : "Only an approved release is published: approve it first."] : []),
      ...(r.status === "approved" && r.approved_eligibility !== "public" ? [`Approved for ${r.approved_eligibility} only; publication is for public releases.`] : []),
      ...(r.availability !== "available" ? [`The release is ${r.availability}.`] : []),
      ...(actor.via !== "web" ? ["Releases are published in the browser."] : []),
      ...(r.status === "approved" ? separation("publication") : []),
      ...(r.status === "approved" && r.approved_eligibility === "public" ? signing : []),
    ]);
    const review = (what: string) => gate([
      ...(!may.approve ? [`HCG has not granted your account ${P.approverCentralId} for HCG Store.`] : []),
      ...(!["submitted", "approved"].includes(r.status) ? [`Only a submitted or approved (unpublished) release can be ${what}.`] : []),
    ]);
    const edit = gate([
      ...(!may.submit ? [`HCG has not granted your account ${P.publisherCentralId} for HCG Store.`] : []),
      ...(!open ? [`The release is ${r.status}; its record is final. Create a new build instead.`] : []),
    ]);
    const steps = { submit, founderException: founderGate, approve, publish, reject: review("rejected"), requestChanges: review("returned for changes"), edit };
    const next = r.status === "draft" ? submit : r.status === "submitted" ? approve : r.status === "approved" ? publish : null;
    const reviewNotes = (db.prepare("SELECT at, action, detail FROM pub_audit WHERE release_id = ? AND action IN ('release.changes-requested', 'release.rejected') ORDER BY seq DESC LIMIT 5").all(r.id) as { at: number; action: string; detail: string }[])
      .map((x) => ({ at: x.at, action: x.action, reason: (JSON.parse(x.detail) as { reason?: string }).reason ?? null }));
    return {
      releaseId: r.id, version: r.version, status: r.status, stage: stageOf(r), availability: r.availability, revision: r.revision,
      requestedEligibility: r.requested_eligibility, approvedEligibility: r.approved_eligibility,
      files: {
        verified: verified.length, pending: pending.length, rejected: rejected.length,
        list: views.map((a) => ({ id: a.id, fileName: a.fileName, platform: a.platform, status: a.status, sha256: a.sha256, signingReported: a.signingReported.status,
          readiness: a.readiness, problems: (a.validation as { problems?: string[] } | null)?.problems ?? [], passport: (() => { const pp = (a.provenance as (Provenance & { passport?: { provider: string | null; runId: string | null; commit: string | null } }) | null)?.passport; return pp ? { matched: true, provider: pp.provider ?? null, runId: pp.runId ?? null, commit: pp.commit ?? null } : null; })(),
          buildProvider: a.provenance?.buildProvider ?? null })),
      },
      signing: { publicBlockers: signing, notarized: verified.filter((a) => a.platform === "macos").map((a) => ({ fileName: a.fileName, notarized: a.readiness.status === "ready" })) },
      permissions: { ...may, required: { submit: P.publisherCentralId, approve: P.approverCentralId, publish: P.publicationCentralId } },
      governance: {
        sameParty, createdBy: r.created_by === actor.sub ? "you" : r.created_by.startsWith("import:") ? r.created_by : "another account",
        submittedBy: (() => { const s = submitterOf(r.id); return !s ? null : s === actor.sub ? "you" : "another account"; })(),
        exception: exception ? { id: exception.id, artifactDigest: exception.artifactDigest, createdAt: exception.createdAt } : null,
        founderConfirmedByHcg: founder ? founder.confirmed : null,
        filesDigest: artifactSetDigest(db, r.id),
        independentReview: !sameParty,
      },
      steps, outstanding: next ? next.reasons : [], reviewNotes,
    };
  }

  /** Free windows anchored to this release's publication start now and last their stated duration. */
  function startPublicationWindows(releaseId: string, at: number) {
    const ws = db.prepare("SELECT id, duration_ms FROM free_windows WHERE release_id = ? AND anchor = 'publication' AND starts_at IS NULL AND terminated_at IS NULL").all(releaseId) as { id: string; duration_ms: number }[];
    for (const w of ws) {
      db.prepare("UPDATE free_windows SET starts_at = ?, ends_at = ? WHERE id = ?").run(at, at + w.duration_ms, w.id);
      db.prepare("INSERT INTO free_window_events (at, window_id, action, detail, authorised_by, performed_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(at, w.id, "window.started-at-publication", JSON.stringify({ releaseId, startsAt: at, endsAt: at + w.duration_ms }), "release publication (window authorised when it was prepared)", "HCG Store");
    }
  }

  /** Recomputes the audit chain; false when any row was altered outside the API. */
  const auditIntact = () => auditChainIntact(db);

  // ------------------------------------------------------------- who is calling, and what HCG allows

  /**
   * Changing the files of a submitted or approved release takes it back to draft: the approval (if any) no longer
   * applies, and the release must be submitted and approved again. Call inside a transaction.
   */
  function invalidate(actor: string, r: ReleaseRow, reason: string) {
    if (r.status === "draft") return;
    db.prepare("UPDATE pub_releases SET status = 'draft', submitted_at = NULL, approved_eligibility = NULL, approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").run(now(), r.id);
    audit(actor, "release.approval-invalidated", r.id, null, { previousStatus: r.status, previousEligibility: r.approved_eligibility, reason });
  }

  async function actorOf(req: IncomingMessage): Promise<Actor> {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      if (!deps.connect) throw new HttpError(503, "hcg_connect_not_configured", "HCG Connect is not configured for this Store.");
      try {
        const payload = await deps.connect.verifyAccessTokenFrom(auth.slice(7).trim(), P.clientIds);
        return { sub: payload.sub!, accessToken: auth.slice(7).trim(), via: "desktop", email: typeof payload.email === "string" ? payload.email : null, clientId: typeof payload.client_id === "string" ? payload.client_id : null };
      } catch (e) {
        throw new HttpError(401, "invalid_token", `HCG Connect did not confirm this sign-in: ${(e as Error).message}`);
      }
    }
    const fresh = await deps.freshSession(req);
    if (fresh.unavailable) throw new HttpError(503, "hcg_unavailable", "Your sign-in could not be checked right now. Nothing was changed.");
    if (!fresh.session) throw new HttpError(401, "sign_in_required", "Sign in with HCG Connect.");
    return { sub: fresh.session.sub, accessToken: fresh.session.accessToken, via: "web", email: fresh.session.email, csrf: csrfFor(fresh.session.idHash) };
  }

  /** CSRF token bound to one Store session: HMAC of the session's ID hash (the session ID itself never leaves the cookie). */
  function csrfFor(sessionIdHash: string) {
    return createHmac("sha256", cfg.secretKey).update(`hcg-store-csrf:${sessionIdHash}`).digest("base64url");
  }

  /**
   * Browser changes: the request comes from the Store's own origin AND carries the session's CSRF token in X-HCG-CSRF
   * (a header a cross-site form or image can never send). Desktop bearer calls carry no cookie and need neither.
   */
  function assertCsrf(req: IncomingMessage, actor: Actor) {
    assertSameOrigin(req, cfg.publicOrigin);
    const sent = String(req.headers["x-hcg-csrf"] ?? "");
    const want = actor.csrf ?? "";
    if (!sent || sent.length !== want.length || !timingSafeEqual(Buffer.from(sent), Buffer.from(want))) {
      throw new HttpError(403, "csrf_token_required", "Reload HCG Store and try again (the request did not carry this session's security token).");
    }
  }

  /** Publication (approval, publication, delivery) is on for this product: mode "enabled" and inside the product limit. */
  function publicationOn(productId: string): boolean {
    return P.publicationEnabled && (!P.publicationProducts.length || P.publicationProducts.includes(productId));
  }

  // ------------------------------------------------------------- rate limits (per person; per file for upload chunks)

  const windows = new Map<string, { start: number; n: number }>();
  function rateLimit(key: string, perMinute: number) {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      windows.set(key, { start: t, n: 1 });
      if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
      return;
    }
    if (++w.n > perMinute) {
      throw new HttpError(429, "rate_limited", `Too many requests. Try again in ${Math.ceil((w.start + 60_000 - t) / 1000)} seconds.`);
    }
  }

  // ------------------------------------------------------------- optimistic concurrency

  /** If-Match: "<revision>" refuses a change based on an outdated copy instead of silently overwriting it. */
  function expectRevision(req: IncomingMessage, current: { revision: number }, what = "release") {
    const h = req.headers["if-match"];
    if (!h) return;
    const want = Number(String(h).replace(/^W\//, "").replaceAll('"', "").trim());
    if (!Number.isInteger(want) || want !== current.revision) {
      throw new HttpError(409, "revision_conflict", `This ${what} changed since you loaded it (you have revision ${String(h)}, HCG Store has ${current.revision}). Reload it and try again.`);
    }
  }

  /**
   * HCG's contract (main-site Maker/Store handoff v2, 17 Nov 2026): `store.publish` and `store.release.approve` are
   * personal grants on HCG Store's own central product, `hcg.store`, whatever product is being published. A Maker
   * licence, a purchase, organisation membership or another product's permission never counts.
   */
  function permissionScope(_productId: string): string {
    return STORE_CENTRAL_PRODUCT_ID;
  }

  async function permitted(actor: Actor, permission: "publish" | "approve" | "publication" | "offers", productId: string): Promise<boolean> {
    // A permission whose central key is not configured is never granted (offers until HCG issues it; approval and
    // publication in "uploads" mode).
    const feature = permission === "publish" ? P.publisherCentralId : permission === "approve" ? P.approverCentralId : permission === "publication" ? P.publicationCentralId : P.offersCentralId;
    if (!feature) return false;
    const subject: Subject = { sub: actor.sub, accessToken: actor.accessToken };
    // A central feature of the product (HCG's planned staff permissions `store.publish` and `store.release.approve`),
    // checked with the caller's own HCG token on every action and never cached. Owning the product, an HCG role, or
    // anything the client sends grants nothing. Until HCG creates the features, /check answers feature_unavailable
    // and the answer is "not permitted".
    const r = await authority.checkFeature(subject, permissionScope(productId), feature);
    if (r.status === "unavailable") throw new HttpError(503, "hcg_unavailable", "HCG could not confirm your publishing permission right now. Nothing was changed.");
    return r.status === "granted";
  }

  async function requirePermission(actor: Actor, permission: "publish" | "approve" | "publication" | "offers", productId: string) {
    if (!(await permitted(actor, permission, productId))) {
      const why = {
        publish: ["not_publisher", "HCG has not granted your account permission to submit releases of this product."],
        approve: ["not_approver", "HCG has not granted your account permission to approve releases of this product."],
        publication: ["not_publication", "HCG has not granted your account permission to publish approved releases."],
        offers: ["not_offers_manager", P.offersCentralId ? "HCG has not granted your account permission to manage offers and free testing periods." : "Pricing and Offers is not enabled on this Store yet (HCG has not issued its permission)."],
      }[permission];
      throw new HttpError(403, why[0]!, why[1]!);
    }
  }

  // ------------------------------------------------------------- products and releases

  function productInfo(productId: string): { source: "catalogue" | "draft"; title: string; editions: string[]; centralId: string | null; packageIds: string[] } | null {
    const p = findProduct(registry, productId);
    if (p) return { source: "catalogue", title: p.name, editions: p.editions.map((e) => e.id), centralId: p.registry.centralId, packageIds: p.editions.flatMap((e) => e.identifiers.filter((i) => i.kind === "debian-package").map((i) => i.value)) };
    const d = draftProduct(productId);
    return d ? { source: "draft", title: d.metadata.title, editions: d.metadata.editions.map((e) => e.id), centralId: null, packageIds: [] } : null;
  }

  type DraftProductRow = { id: string; title: string; created_by: string; created_at: number; metadata: string; revision: number; updated_at: number | null; updated_by: string | null };
  function draftProduct(productId: string) {
    const d = db.prepare("SELECT * FROM pub_products WHERE id = ?").get(productId) as DraftProductRow | undefined;
    if (!d) return null;
    const stored = JSON.parse(d.metadata || "{}") as Partial<DraftProductMetadata>;
    const metadata = DraftProductMetadata.parse({ ...stored, title: stored.title ?? d.title });
    return { id: d.id, source: "draft" as const, metadata, revision: d.revision, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at, updatedBy: d.updated_by };
  }

  const release = (id: string) => db.prepare("SELECT * FROM pub_releases WHERE id = ?").get(id) as ReleaseRow | undefined;
  const artifact = (id: string) => db.prepare("SELECT * FROM pub_artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  const artifactsOf = (releaseId: string) => db.prepare("SELECT * FROM pub_artifacts WHERE release_id = ? ORDER BY created_at, rowid").all(releaseId) as ArtifactRow[];

  /** Requests recorded for a release (Distribution Studio: disable, enable, restore, supersede, make current). They change nothing. */
  function requestsOf(releaseId: string) {
    return (db.prepare("SELECT seq, at, actor, detail FROM pub_audit WHERE release_id = ? AND action = 'release.request' ORDER BY seq").all(releaseId) as { seq: number; at: number; actor: string; detail: string }[])
      .map((x) => ({ seq: x.seq, at: x.at, by: x.actor, ...(JSON.parse(x.detail) as { action: string; reason: string; via?: string; status?: string }) }));
  }

  function releaseView(r: ReleaseRow, withAudit = true) {
    const pinfo = productInfo(r.product_id);
    return {
      id: r.id, productId: r.product_id, productTitle: pinfo?.title ?? r.product_id, productSource: r.product_source, editionId: r.edition_id,
      version: r.version, build: r.build, channel: r.channel, releaseNotes: JSON.parse(r.release_notes), compatibility: JSON.parse(r.compatibility),
      distribution: r.distribution, requestedEligibility: r.requested_eligibility, destinations: JSON.parse(r.destinations), status: r.status,
      approvedEligibility: r.approved_eligibility, createdBy: r.created_by, createdAt: r.created_at, submittedAt: r.submitted_at,
      approvedBy: r.approved_by, approvedAt: r.approved_at, withdrawnReason: r.withdrawn_reason,
      publishedAt: r.published_at, publishedBy: r.published_by, supersededBy: r.superseded_by, stage: stageOf(r),
      availability: r.availability, availabilityReason: r.availability_reason, revision: r.revision,
      supersedePreviousOnPublish: r.supersede_on_publish === 1, uploadSource: r.upload_source ? JSON.parse(r.upload_source) : null,
      publicationRequest: r.publication_request ? JSON.parse(r.publication_request) : null,
      requests: requestsOf(r.id),
      lifecycle: lifecycleOf(r, artifactsOf(r.id), currentTargetsOfRelease(db, r.id).length),
      targets: targetsOf(db, r).map((t) => {
        const cur = currentRowsForProduct(db, r.product_id).find((c) => c.edition_key === t.editionKey && c.platform === t.platform && c.arch === t.arch && c.channel === t.channel);
        return { editionId: t.editionKey || null, platform: t.platform, arch: t.arch, channel: t.channel, current: cur?.release_id === r.id, currentRelease: cur?.release_id ?? null };
      }),
      knownLimitations: JSON.parse(r.known_limitations ?? "[]") as string[], importedFrom: r.imported_from ? JSON.parse(r.imported_from) : null,
      submittedBy: submitterOf(r.id), exceptions: exceptionsFor(db, r.id),
      reviewUrl: `${cfg.publicOrigin}/publishing/releases/${r.id}`,
      artifacts: artifactsOf(r.id).map(artifactView),
      audit: withAudit
        ? (db.prepare("SELECT seq, at, actor, action, artifact_id, detail FROM pub_audit WHERE release_id = ? ORDER BY seq").all(r.id) as { seq: number; at: number; actor: string; action: string; artifact_id: string | null; detail: string }[])
            .map((a) => ({ ...a, detail: JSON.parse(a.detail) }))
        : undefined,
    };
  }

  /**
   * Release Manager stage: draft · validation-pending · validation-failed · uploaded · awaiting-approval · approved ·
   * published · superseded · withdrawn. Derived from the release status and its files; never stored separately.
   */
  function stageOf(r: ReleaseRow): string {
    if (r.status === "submitted") return "awaiting-approval";
    if (r.status !== "draft") return r.status;
    const files = artifactsOf(r.id).filter((a) => a.status !== "removed");
    if (files.some((a) => ["awaiting-upload", "uploading"].includes(a.status))) return "validation-pending";
    if (files.some((a) => a.status === "verified")) return "uploaded";
    if (files.some((a) => a.status === "rejected")) return "validation-failed";
    return "draft";
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
      provenance: a.provenance ? (JSON.parse(a.provenance) as Provenance) : null,
      customerDelivery: !STAFF_ONLY_FORMATS.has(a.format),
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
    try { rateLimit(`chunks:${t.a}`, 1200); } catch (e) { const x = e as HttpError; return errorJson(res, x.status, x.code, x.message, { "retry-after": "10" }); }
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

  /** What this Store allows right now (independent switches), for apps to show precisely what works. */
  function capabilityFlags() {
    return {
      products: true, drafts: true, uploads: true, resumableUploads: true, passports: true, submission: true,
      approval: P.publicationEnabled && !!P.approverCentralId, publication: P.publicationEnabled && !!P.publicationCentralId,
      publicDelivery: P.publicationEnabled && cfg.freeDownloads, offers: !!P.offersCentralId,
      // Distribution Studio (HCG Executable Maker), additive: official product metadata in the product list, the
      // submitter's publication request, recorded availability requests, and compatible (per-target) supersede.
      productMetadata: true, publicationRequests: true, availabilityRequests: true, supersedeCompatible: true, withdraw: true,
      // Release lifecycle (Control Center): disable/enable/archive (any mode); supersede, restore and revoke in the
      // browser by the people HCG lets publish (only when publication is enabled); explicit current release per target.
      availability: true, restore: P.publicationEnabled && !!P.publicationCentralId, perTargetCurrent: true, revisions: true, changes: true,
    };
  }

  /** Bytes of every release file the Store keeps or is receiving (removed and rejected files excluded). */
  function storageUsed(): number {
    return (db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM pub_artifacts WHERE status NOT IN ('removed', 'rejected')").get() as { n: number }).n;
  }

  async function hashFile(file: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
    return h.digest("hex");
  }

  /** Verified files of a release whose stored bytes no longer hash to the recorded SHA-256 (or are missing). */
  async function storedMismatches(releaseId: string): Promise<{ id: string; fileName: string }[]> {
    const bad: { id: string; fileName: string }[] = [];
    for (const a of artifactsOf(releaseId).filter((x) => x.status === "verified")) {
      const file = stagingPath(a.storage_key!);
      if (!existsSync(file) || (await hashFile(file)) !== a.sha256) bad.push({ id: a.id, fileName: a.file_name });
    }
    return bad;
  }

  /**
   * Drops outstanding short-lived download links to these releases' files. Links are also re-authorised when used,
   * so this is belt and braces; bytes already being streamed when a release is stopped cannot be recalled.
   */
  function invalidateGrantsOf(releaseIds: string[]) {
    for (const id of releaseIds) db.prepare("UPDATE pub_download_grants SET expires_at = 0 WHERE artifact_id IN (SELECT id FROM pub_artifacts WHERE release_id = ?)").run(id);
  }

  /** Where a release came from: the HCG Store website, or the HCG Connect client (desktop app) that uploaded it. */
  function uploadSourceOf(actor: Actor) {
    return actor.via === "web" ? { via: "web", client: "hcg-store-website" } : { via: "desktop", client: actor.clientId ?? null };
  }

  async function complete(actor: Actor, a: ArtifactRow, res: ServerResponse) {
    const out = await finalize(actor.sub, a);
    return json(res, out.status, out.body);
  }

  /** Verifies a fully received file (hash, format, archive safety, kind) and moves it to immutable storage, or rejects it. */
  async function finalize(actorSub: string, a: ArtifactRow): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = release(a.release_id)!;
    const up = db.prepare("SELECT * FROM pub_uploads WHERE artifact_id = ?").get(a.id) as { received_bytes: number; staging_key: string } | undefined;
    if (!up || r.status !== "draft") return { status: 409, body: { error: { code: "not_uploading", message: "This file is not waiting for an upload." } } };
    if (up.received_bytes !== a.size_bytes) return { status: 409, body: { error: "incomplete", message: `Received ${up.received_bytes} of ${a.size_bytes} bytes.`, received: up.received_bytes } };
    const staged = stagingPath(up.staging_key);
    const sha256 = await hashFile(staged);
    const problems: string[] = [];
    if (sha256 !== a.declared_sha256) problems.push(`SHA-256 mismatch: received ${sha256}, declared ${a.declared_sha256}. The file changed or was corrupted in transit.`);
    if (REJECTED_SHA256.has(sha256)) problems.push("HCG Store refused this exact file earlier (rejected-artifacts.json); it can never be published.");
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
        audit(actorSub, "artifact.rejected", r.id, a.id, { problems, sha256 });
      });
      rmSync(staged, { force: true });
      return { status: 422, body: { error: "artifact_rejected", message: problems.join(" "), artifact: artifactView(artifact(a.id)!) } };
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
      audit(actorSub, "artifact.verified", r.id, a.id, { sha256, sizeBytes: statSync(final).size, kind: content?.kind, signatureStructure: validation.signatureStructure, ios: content?.ios });
    });
    return { status: 200, body: { artifact: artifactView(artifact(a.id)!) } };
  }

  // ------------------------------------------------------------- downloads

  type Decision = { ok: true; basis: string } | { ok: false; status: number; code: string; message: string };

  async function authorizeDownload(subject: Subject & { via?: Actor["via"] }, a: ArtifactRow): Promise<Decision> {
    const r = release(a.release_id);
    if (!r || a.status !== "verified") return { ok: false, status: 404, code: "not_found", message: "Not found." };
    if (r.status === "withdrawn") return { ok: false, status: 410, code: "withdrawn", message: "This release was withdrawn." };
    // Revoked: stopped for everyone, staff included (the files are kept for the record, never served).
    if (r.availability === "revoked") return { ok: false, status: 410, code: "revoked", message: "This release was revoked." };
    const actor: Actor = { sub: subject.sub, accessToken: subject.accessToken, via: subject.via ?? "web" };
    if (await permitted(actor, "publish", r.product_id)) return { ok: true, basis: "publisher" };
    // Draft review: the people HCG allows to approve or publish this product may download it to check it first.
    if (await permitted(actor, "approve", r.product_id)) return { ok: true, basis: "approver-review" };
    if (await permitted(actor, "publication", r.product_id)) return { ok: true, basis: "publisher-review" };
    // Private uploads only: nothing is delivered to anyone but the staff above.
    if (!publicationOn(r.product_id)) return { ok: false, status: 403, code: "publication_disabled", message: "This release is not available." };
    if (STAFF_ONLY_FORMATS.has(a.format)) return { ok: false, status: 403, code: "staff_only", message: "This file is for authorised distribution only and is never delivered to customers." };
    if (r.status === "superseded") return { ok: false, status: 410, code: "superseded", message: "A newer release replaced this one." };
    if (r.availability !== "available") return { ok: false, status: 410, code: r.availability, message: `This release is ${r.availability}.` };
    // Public delivery needs the explicit publication step; internal testing needs only its approval.
    const deliverable = r.approved_eligibility === "public" ? r.status === "published" : r.approved_eligibility === "internal-testing" && r.status === "approved";
    if (!deliverable) {
      return { ok: false, status: 403, code: "not_released", message: "This release is not published for you to download." };
    }
    // Public delivery: only the CURRENT release of the file's target (product, edition, platform, architecture, channel).
    if (r.approved_eligibility === "public" && !artifactIsCurrent(db, a, r)) {
      return { ok: false, status: 410, code: "not_current", message: "A different release is current for this platform; this one is kept in the history only." };
    }
    if (r.approved_eligibility === "public" && r.distribution === "free") {
      // Free public release: only while downloads of free releases are on and a free testing window is open
      // (or the edition is permanently free).
      if (!cfg.freeDownloads) return { ok: false, status: 403, code: "downloads_not_available", message: "Downloads are not available yet." };
      if (!freePublicFor(r.product_id, r.edition_id).some((x) => x.id === a.id)) {
        return { ok: false, status: 403, code: "free_period_closed", message: "This release is not free right now." };
      }
      return { ok: true, basis: "public-free" };
    }
    if (!cfg.protectedDownloads) return { ok: false, status: 403, code: "downloads_not_available", message: "Downloads are not available yet." };
    const central = productInfo(r.product_id)?.centralId;
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
    if (!publicationOn(productId)) return [];
    const rows = db.prepare(
      `SELECT a.* FROM pub_artifacts a JOIN pub_releases r ON r.id = a.release_id
       WHERE r.product_id = ? AND r.edition_id IS ? AND r.status = 'published' AND r.approved_eligibility = 'public' AND r.availability = 'available'
         AND a.status = 'verified' AND a.format NOT IN ('aab')`,
    ).all(productId, editionId) as ArtifactRow[];
    // Only the current release of each target is offered; superseded and replaced releases stay in the history.
    return rows.filter((a) => artifactIsCurrent(db, a, release(a.release_id)!)).map((a) => asProtected(a, productId, editionId));
  }

  /**
   * The open free testing window for this edition, or "permanent" when the catalogue says the edition is free.
   * Without either, a free public release is not delivered (free-windows.ts).
   */
  function freeBasis(productId: string, editionId: string | null): { kind: "permanent" } | { kind: "window"; window: FreeWindow } | null {
    const edition = findProduct(registry, productId)?.editions.find((e) => e.id === editionId);
    if (edition?.pricingModel === "free") return { kind: "permanent" };
    const w = openWindowFor(db, productId, editionId, now());
    return w ? { kind: "window", window: w } : null;
  }

  function freePublicFor(productId: string, editionId: string | null): ProtectedArtifact[] {
    if (!publicationOn(productId)) return [];
    const basis = freeBasis(productId, editionId);
    if (!basis) return [];
    const rows = db.prepare(
      `SELECT a.* FROM pub_artifacts a JOIN pub_releases r ON r.id = a.release_id
       WHERE r.product_id = ? AND r.edition_id IS ? AND r.status = 'published' AND r.approved_eligibility = 'public' AND r.availability = 'available'
         AND r.distribution = 'free' AND a.status = 'verified' AND a.format NOT IN ('aab')`,
    ).all(productId, editionId) as ArtifactRow[];
    // A window may cover one release only.
    const only = basis.kind === "window" ? basis.window.releaseId : null;
    return rows.filter((a) => (!only || a.release_id === only) && artifactIsCurrent(db, a, release(a.release_id)!)).map((a) => asProtected(a, productId, editionId));
  }

  function asProtected(a: ArtifactRow, productId: string, editionId: string | null): ProtectedArtifact {
    return { id: a.id, productId, releaseId: a.release_id, catalogueArtifactId: a.id, editionId, fileName: a.file_name, contentType: a.content_type,
      sha256: a.sha256!, storageKey: a.storage_key!, deliveryApproved: true, testOnly: false };
  }

  function publishedById(id: string): ProtectedArtifact | undefined {
    if (!P.publicationEnabled) return undefined;
    const a = artifact(id);
    const r = a ? release(a.release_id) : undefined;
    if (!a || !r || !publicationOn(r.product_id) || r.status !== "published" || r.approved_eligibility !== "public" || r.availability !== "available" || a.status !== "verified" || STAFF_ONLY_FORMATS.has(a.format)) return undefined;
    if (!artifactIsCurrent(db, a, r)) return undefined;
    return asProtected(a, r.product_id, r.edition_id);
  }

  function publishedMeta(id: string): PublishedFileMeta | undefined {
    const a = artifact(id);
    const r = a ? release(a.release_id) : undefined;
    if (!a || !r) return undefined;
    return {
      version: r.version, channel: r.channel, architectures: JSON.parse(a.architectures), platform: a.platform, format: a.format,
      sizeBytes: a.size_bytes, sha256: a.sha256, minimumOs: a.minimum_os,
      signing: (JSON.parse(a.signing_reported) as { status: string }).status, publishedAt: r.published_at,
    };
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
    const rows = (db.prepare("SELECT * FROM pub_releases WHERE approved_eligibility = 'public' AND published_at IS NOT NULL AND status IN ('published', 'superseded', 'withdrawn') ORDER BY published_at").all() as ReleaseRow[])
      .filter((r) => (JSON.parse(r.destinations) as string[]).includes("hcg-repo"));
    const allowed = new Map<string, boolean>();
    const releases = [];
    for (const r of rows) {
      if (!allowed.has(r.product_id)) allowed.set(r.product_id, (await permitted(actor, "publish", r.product_id)) || (await permitted(actor, "approve", r.product_id)));
      if (!allowed.get(r.product_id)) continue;
      releases.push({
        id: r.id, productId: r.product_id, editionId: r.edition_id, version: r.version, build: r.build, channel: r.channel, distribution: r.distribution,
        // HCG Repo reads "approved" (may index) and "withdrawn" (must remove); lifecycle gives the Store's own state.
        status: r.status === "withdrawn" ? "withdrawn" : "approved", lifecycle: r.status, approvedEligibility: r.approved_eligibility, approvedAt: r.approved_at, publishedAt: r.published_at,
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
    if (!P.enabled) {
      // The website asks /me on product pages to decide whether to show "Manage product": answer plainly (no data).
      if (p === "/api/v1/publishing/me" && m === "GET") {
        json(res, 200, { administrator: false, permissions: { submit: false, approve: false, publish: false, offers: false }, publishingMode: "disabled" });
        return true;
      }
      errorJson(res, 404, "publishing_disabled", "Publishing is not enabled on this Store.");
      return true;
    }
    let match: RegExpExecArray | null;

    if ((match = /^\/publishing-upload\/v1\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(p)) && (m === "PUT" || m === "GET")) { await putChunk(req, res, match[1]!); return true; }
    if ((match = /^\/publishing-download\/v1\/([A-Za-z0-9_-]{20,})$/.exec(p)) && m === "GET") { await serveDownload(res, match[1]!); return true; }

    const actor = await actorOf(req);
    // Cookie-authenticated changes must come from the Store's own pages with the session's CSRF token; bearer calls
    // carry no cookie.
    if (actor.via === "web" && m !== "GET") assertCsrf(req, actor);
    rateLimit(`person:${actor.sub}`, P.adminRatePerMinute);

    if (p === "/api/v1/repo/releases" && m === "GET") { send(json(res, 200, await repoReleases(actor, url))); return true; }

    if (p === "/api/v1/publishing/whoami" && m === "GET") {
      return send(json(res, 200, { sub: actor.sub, email: actor.email ?? null, via: actor.via, publisherPermission: P.publisherCentralId, approverPermission: P.approverCentralId, maxUploadBytes: P.maxUploadBytes, chunkBytes: P.chunkBytes, publishingMode: P.mode, capabilities: capabilityFlags() }));
    }
    if (p === "/api/v1/publishing/me" && m === "GET") {
      // What this person may do, as HCG decides it now (checked live, never cached). The website uses it only to show
      // or hide controls; every operation is authorised again on the server. Ordinary accounts get all false.
      const permissions = {
        submit: await permitted(actor, "publish", STORE_CENTRAL_PRODUCT_ID),
        approve: await permitted(actor, "approve", STORE_CENTRAL_PRODUCT_ID),
        publish: await permitted(actor, "publication", STORE_CENTRAL_PRODUCT_ID),
        offers: await permitted(actor, "offers", STORE_CENTRAL_PRODUCT_ID),
      };
      return send(json(res, 200, {
        sub: actor.sub, email: actor.email ?? null, via: actor.via, permissions,
        administrator: permissions.submit || permissions.approve || permissions.publish,
        publishingMode: P.mode, capabilities: capabilityFlags(),
        devicePolicy: { mode: P.devicePolicy, note: "Device-aware authorisation (HCG UEM) is not active." },
        ...(actor.via === "web" ? { csrfToken: actor.csrf } : {}),
      }));
    }
    if (p === "/api/v1/publishing/changes" && m === "GET") {
      // Synchronisation feed for every management client (website, Executable Maker, Store Manager): audited changes
      // after `since` (an audit sequence number), oldest first. Clients refetch what changed; HCG Store stays the source.
      if (!(await mayReview(actor, STORE_CENTRAL_PRODUCT_ID))) throw new HttpError(403, "not_publisher", "HCG has not granted your account a publishing permission.");
      const since = Math.max(0, Number(url.searchParams.get("since") ?? "0") || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "200") || 200));
      const rows = db.prepare("SELECT seq, at, action, release_id, artifact_id, detail FROM pub_audit WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit) as { seq: number; at: number; action: string; release_id: string | null; artifact_id: string | null; detail: string }[];
      const latest = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM pub_audit").get() as { n: number }).n;
      return send(json(res, 200, {
        latestSeq: latest,
        changes: rows.map((c) => {
          const rel = c.release_id ? release(c.release_id) : undefined;
          const d = JSON.parse(c.detail) as { productId?: string };
          return { seq: c.seq, at: c.at, action: c.action, releaseId: c.release_id, artifactId: c.artifact_id, productId: rel?.product_id ?? d.productId ?? null, revision: rel?.revision ?? null };
        }),
      }));
    }
    if ((match = /^\/api\/v1\/publishing\/products\/([a-z0-9-]{1,60})$/.exec(p)) && (m === "GET" || m === "PATCH")) {
      const productId = match[1]!;
      if (!(await mayReview(actor, productId))) throw new HttpError(403, "not_publisher", "HCG has not granted your account a publishing permission.");
      const catalogue = findProduct(registry, productId);
      const draft = catalogue ? null : draftProduct(productId);
      if (!catalogue && !draft) throw new HttpError(404, "unknown_product", "Unknown product.");
      if (m === "PATCH") {
        await requirePermission(actor, "publish", productId);
        if (catalogue) {
          throw new HttpError(409, "catalogue_product", "Listed products are defined by HCG's catalogue (HCG ERP is the source of truth). Propose metadata changes there; HCG Store edits only its own draft products.");
        }
        expectRevision(req, draft!, "product");
        // Only the fields sent change (a partial schema would otherwise fill in defaults and wipe the rest).
        const raw = await readJson(req);
        const parsed = DraftProductMetadata.partial().parse(raw) as Record<string, unknown>;
        const patch = Object.fromEntries(Object.keys(raw).filter((k) => k in parsed).map((k) => [k, parsed[k]])) as Partial<DraftProductMetadata>;
        const next = DraftProductMetadata.parse({ ...draft!.metadata, ...patch });
        const removedEditions = draft!.metadata.editions.filter((e) => !next.editions.some((n) => n.id === e.id)).map((e) => e.id);
        const used = removedEditions.filter((e) => db.prepare("SELECT 1 FROM pub_releases WHERE product_id = ? AND edition_id = ? LIMIT 1").get(productId, e));
        if (used.length) throw new HttpError(409, "edition_in_use", `Editions with releases cannot be removed: ${used.join(", ")}.`);
        transaction(db, () => {
          db.prepare("UPDATE pub_products SET title = ?, metadata = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(next.title, JSON.stringify(next), now(), actor.sub, productId);
          audit(actor.sub, "product.draft-updated", null, null, { productId, changed: Object.keys(patch), revisionBefore: draft!.revision, via: actor.via });
        });
      }
      const fresh = catalogue ? null : draftProduct(productId);
      const releases = db.prepare("SELECT * FROM pub_releases WHERE product_id = ? ORDER BY created_at DESC, rowid DESC").all(productId) as ReleaseRow[];
      const counts: Record<string, number> = {};
      for (const r of releases) { const l = lifecycleOf(r, artifactsOf(r.id), currentTargetsOfRelease(db, r.id).length).label; counts[l] = (counts[l] ?? 0) + 1; }
      return send(json(res, 200, {
        id: productId,
        slug: catalogue?.slug ?? null,
        source: catalogue ? "catalogue" : "draft",
        revision: fresh?.revision ?? null,
        metadata: catalogue
          ? { title: catalogue.name, summary: catalogue.summary, categories: [catalogue.category], platforms: catalogue.platforms.map((x) => x.platform), editions: catalogue.editions.map((e) => ({ id: e.id, name: e.name })), visibility: catalogue.visibility }
          : fresh!.metadata,
        centralId: catalogue?.registry.centralId ?? null,
        editable: !catalogue,
        note: catalogue
          ? "Listed product: its catalogue entry comes from HCG (HCG ERP is the source of truth). Releases, platforms and availability are managed here."
          : "Draft product: exists only in HCG Store. Public release needs HCG to register it centrally and add it to the catalogue.",
        current: currentRowsForProduct(db, productId).map((c) => {
          const r = release(c.release_id);
          return { editionId: c.edition_key || null, platform: c.platform, arch: c.arch, channel: c.channel, releaseId: c.release_id, version: r?.version ?? null, build: r?.build ?? null, availability: r?.availability ?? null, status: r?.status ?? null, selectedAt: c.selected_at, selectedBy: c.selected_by };
        }),
        releaseCounts: counts,
      }));
    }
    if (p === "/api/v1/publishing/capabilities" && m === "GET") {
      if (!(await permitted(actor, "publish", STORE_CENTRAL_PRODUCT_ID)) && !(await permitted(actor, "approve", STORE_CENTRAL_PRODUCT_ID)) && !(await permitted(actor, "publication", STORE_CENTRAL_PRODUCT_ID))) {
        throw new HttpError(403, "not_publisher", "HCG has not granted your account a publishing permission.");
      }
      return send(json(res, 200, {
        apiVersion: 1, maxUploadBytes: P.maxUploadBytes, chunkBytes: P.chunkBytes, uploadUrlTtlSeconds: P.uploadUrlTtlSeconds,
        formats: ALLOWED, staffOnlyFormats: [...STAFF_ONLY_FORMATS], buildProviders: BUILD_PROVIDER_IDS,
        storage: { usedBytes: storageUsed(), quotaBytes: P.storageQuotaBytes },
        approvalAndPublication: "browser-only",
        publishingMode: P.mode,
        // Release operations of this API (all clients); each is authorised again on every request.
        operations: {
          prepare: ["products.list", "products.get", "products.draft-create", "products.draft-update", "releases.create", "artifacts.declare", "artifacts.upload", "artifacts.complete", "artifacts.passport", "releases.submit"],
          review: ["releases.approve (browser)", "releases.publish (browser)", "releases.supersede (browser)", "releases.restore (browser)", "releases.revoke (browser)"],
          availability: ["releases.disable", "releases.enable", "releases.archive", "releases.withdraw"],
          sync: ["manager", "changes", "releases.get", "compare", "verify-checksums"],
        },
        concurrency: "If-Match: \"<revision>\" on any change; 409 revision_conflict when another client changed it first.",
        lifecycle: { review: ["draft", "uploading", "validation-required", "ready-for-review", "submitted", "approved", "published", "superseded", "withdrawn"], availability: ["available", "disabled", "archived", "revoked"], currency: ["current", "superseded", "not-current"] },
        capabilities: capabilityFlags(),
        offersEnabled: !!P.offersCentralId,
      }));
    }
    // ---- Pricing and Offers: free testing periods (free-windows.ts). No price, offer, checkout or charge is ever
    // created here; payments are a separate, separately approved system. Each change records the person (their HCG
    // account) as having authorised it and the client that performed it.
    if (p === "/api/v1/publishing/offers/windows" && m === "GET") {
      const productId = url.searchParams.get("productId") ?? undefined;
      if (!(await permitted(actor, "offers", STORE_CENTRAL_PRODUCT_ID)) && !(await mayReview(actor, productId ?? STORE_CENTRAL_PRODUCT_ID))) throw new HttpError(403, "not_offers_manager", "HCG has not granted your account access to offers.");
      const t = now();
      const windows = listWindows(db, t, productId);
      const events = db.prepare(`SELECT at, window_id, action, detail, authorised_by AS authorisedBy, performed_by AS performedBy FROM free_window_events ${productId ? "WHERE window_id IN (SELECT id FROM free_windows WHERE product_id = ?)" : ""} ORDER BY seq`).all(...(productId ? [productId] : [])) as { at: number; window_id: string; action: string; detail: string; authorisedBy: string; performedBy: string }[];
      return send(json(res, 200, { enabled: !!P.offersCentralId, windows, events: events.map((e) => ({ ...e, detail: JSON.parse(e.detail) })) }));
    }
    if ((match = /^\/api\/v1\/publishing\/offers\/windows(?:\/(fw-[a-f0-9]{12})\/(extend|terminate))?$/.exec(p)) && m === "POST") {
      await requirePermission(actor, "offers", STORE_CENTRAL_PRODUCT_ID);
      const who = { authorisedBy: `HCG account ${actor.email ?? actor.sub}`.slice(0, 200), performedBy: actor.via === "web" ? "HCG Store (browser)" : "HCG Store Manager / app" };
      const t = now();
      const day = 24 * 3600 * 1000;
      try {
        if (!match[1]) {
          const b = z.strictObject({
            productId: z.string().regex(kebab), editionId: z.string().regex(kebab).nullable().default(null), releaseId: z.string().regex(/^rel-[a-f0-9]{16}$/).nullable().default(null),
            starts: z.union([z.literal("now"), z.literal("publication"), z.number().int()]), ends: z.number().int().optional(), days: z.number().int().min(1).max(366).optional(),
          }).parse(await readJson(req));
          const product = findProduct(registry, b.productId);
          if (!product || product.visibility === "draft") throw new HttpError(404, "unknown_product", "Unknown product.");
          if (product.editions.length ? !product.editions.some((e) => e.id === b.editionId) : b.editionId !== null) throw new HttpError(400, "bad_edition", "Unknown edition.");
          let publishedAt: number | null = null;
          if (b.releaseId) {
            const r = release(b.releaseId);
            if (!r || r.product_id !== b.productId || r.edition_id !== b.editionId) throw new HttpError(400, "bad_release", "The release is not a release of this product edition.");
            if (r.distribution !== "free") throw new HttpError(400, "not_free", "Only a release distributed as free can be in a free testing period.");
            if (["withdrawn", "superseded"].includes(r.status)) throw new HttpError(409, "release_ended", `The release is ${r.status}.`);
            publishedAt = r.published_at;
          }
          let period: WindowPeriod;
          if (b.starts === "publication") {
            if (!b.releaseId || !b.days) throw new HttpError(400, "bad_period", "A period that starts at publication names the release and a number of days.");
            period = { anchor: "publication", durationMs: b.days * day, publishedAt };
          } else {
            const start = b.starts === "now" ? t : b.starts;
            const end = b.ends ?? (b.days ? start + b.days * day : NaN);
            if (!Number.isFinite(end)) throw new HttpError(400, "bad_period", "Give an end time or a number of days.");
            period = { anchor: "fixed", startsAt: start, endsAt: end };
          }
          return send(json(res, 201, openWindow(db, { productId: b.productId, editionId: b.editionId, releaseId: b.releaseId, period, ...who }, t)));
        }
        if (match[2] === "extend") {
          const b = z.strictObject({ ends: z.number().int().optional(), days: z.number().int().min(1).max(366).optional() }).parse(await readJson(req));
          const change = b.days ? { durationMs: b.days * day } : b.ends ? { endsAt: b.ends } : null;
          if (!change) throw new HttpError(400, "bad_period", "Give a later end time or a total number of days.");
          return send(json(res, 200, extendWindow(db, match[1]!, change, who, t)));
        }
        const b = z.strictObject({ reason: z.string().trim().min(1).max(500) }).parse(await readJson(req));
        return send(json(res, 200, terminateWindow(db, match[1]!, b.reason, who, t)));
      } catch (e) {
        if (e instanceof FreeWindowError) throw new HttpError(409, "window_refused", e.message);
        throw e;
      }
    }
    if (p === "/api/v1/publishing/products" && m === "GET") {
      // With what HCG Store shows publicly about each product (official name, summary, category, development status,
      // platforms, and the OFFICIAL icon and cover from the reviewed catalogue as the Store's own public media URLs;
      // concept artwork is never returned as official), so a publishing app needs no copy of the catalogue.
      const media = (img: { src: string; kind?: string } | null | undefined) => (img && img.kind !== "concept" ? `${cfg.publicOrigin}/${img.src.replace(/^\/+/, "")}` : null);
      const all = [
        ...registry.catalogue.products.map((x) => ({
          id: x.id, title: x.name, source: "catalogue" as const, editions: x.editions.map((e) => ({ id: e.id, name: e.name, platforms: e.platforms })), centralId: x.registry.centralId, hcgRepo: x.hcgRepo.map((l) => l.key),
          slug: x.slug, summary: x.summary, category: x.category, developmentStatus: x.developmentStatus, visibility: x.visibility,
          platforms: x.platforms.map((pl) => ({ platform: pl.platform, support: pl.support, architectures: [] as string[] })),
          icon: media(x.artwork.icon), cover: media(x.artwork.cover), currentReleaseId: x.currentReleaseId ?? null, productUrl: `${cfg.publicOrigin}/apps/${x.slug}`,
        })),
        ...(db.prepare("SELECT id FROM pub_products ORDER BY id").all() as { id: string }[]).map((d) => draftProduct(d.id)!).map((d) => ({
          id: d.id, title: d.metadata.title, source: "draft" as const, editions: d.metadata.editions.map((e) => ({ id: e.id, name: e.name, platforms: d.metadata.platforms })), centralId: null, hcgRepo: [], revision: d.revision,
          slug: null, summary: d.metadata.summary || d.metadata.description[0] || null, category: d.metadata.categories[0] ?? null, developmentStatus: "draft", visibility: d.metadata.visibility,
          platforms: d.metadata.platforms.map((pl) => ({ platform: pl, support: "planned", architectures: [] as string[] })),
          icon: null, cover: null, currentReleaseId: null, productUrl: null,
        })),
      ];
      // Default: products the caller may publish to (Executable Maker, uploads). scope=review: products the caller may
      // publish, approve or publish releases of (Product Manager and Release Manager for reviewers).
      const review = url.searchParams.get("scope") === "review";
      const allowed = [];
      for (const x of all) if (review ? await mayReview(actor, x.id) : await permitted(actor, "publish", x.id)) allowed.push(x);
      return send(json(res, 200, { products: allowed }));
    }
    if (p === "/api/v1/publishing/products" && m === "POST") {
      const body = z.strictObject({
        id: z.string().regex(kebab).max(60), title: text.max(120), metadata: DraftProductMetadata.partial().optional(),
        // Distribution Studio's descriptive fields, stored in the same revisioned metadata as the website's.
        description: z.string().trim().max(2000).optional(), category: z.string().regex(kebab).max(40).optional(), platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).optional(),
      }).parse(await readJson(req));
      await requirePermission(actor, "publish", "*");
      if (findProduct(registry, body.id) || productInfo(body.id)) throw new HttpError(409, "exists", "A product with this ID already exists.");
      const fromStudio: Partial<DraftProductMetadata> = {
        ...(body.description ? (body.description.length <= 300 ? { summary: body.description } : { summary: body.description.slice(0, 297) + "…", description: [body.description] }) : {}),
        ...(body.category ? { categories: [body.category] } : {}),
        ...(body.platforms ? { platforms: [...new Set(body.platforms)] } : {}),
      };
      const metadata = DraftProductMetadata.parse({ ...fromStudio, ...(body.metadata ?? {}), title: body.title });
      transaction(db, () => {
        db.prepare("INSERT INTO pub_products (id, title, created_by, created_at, metadata, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(body.id, body.title, actor.sub, now(), JSON.stringify(metadata), now(), actor.sub);
        audit(actor.sub, "product.draft-created", null, null, { productId: body.id, title: body.title, via: actor.via, note: "Store draft only: no central HCG product, entitlement or price is created." });
      });
      return send(json(res, 201, {
        id: body.id, title: body.title, source: "draft", metadata, revision: 1,
        description: body.description ?? (metadata.summary || null), category: metadata.categories[0] ?? null, platforms: metadata.platforms,
        note: "A draft product exists only in HCG Store. Listing it publicly needs HCG to add it to the reviewed catalogue with a confirmed central product ID, official artwork and editions.",
      }));
    }
    if (p === "/api/v1/publishing/releases" && m === "GET") {
      const productId = url.searchParams.get("productId") ?? "";
      await requirePermission(actor, "publish", productId);
      const rows = db.prepare("SELECT * FROM pub_releases WHERE product_id = ? ORDER BY created_at DESC").all(productId) as ReleaseRow[];
      return send(json(res, 200, { releases: rows.map((r) => releaseView(r, false)) }));
    }
    if (p === "/api/v1/publishing/manager" && m === "GET") {
      // Release Manager: every release of every product this account may publish or approve, newest first, with its
      // stage. Metadata only; each product is checked with HCG.
      const onlyProduct = url.searchParams.get("productId");
      const withArchived = url.searchParams.get("include") === "archived";
      const rows = (db.prepare("SELECT * FROM pub_releases ORDER BY created_at DESC, rowid DESC LIMIT 2000").all() as ReleaseRow[])
        .filter((r) => (!onlyProduct || r.product_id === onlyProduct) && (withArchived || r.availability !== "archived"));
      const allowed = new Map<string, { publish: boolean; approve: boolean; publication: boolean }>();
      const releases = [];
      for (const r of rows) {
        if (!allowed.has(r.product_id)) allowed.set(r.product_id, { publish: await permitted(actor, "publish", r.product_id), approve: await permitted(actor, "approve", r.product_id), publication: await permitted(actor, "publication", r.product_id) });
        const may = allowed.get(r.product_id)!;
        if (!may.publish && !may.approve && !may.publication) continue;
        const v = releaseView(r, false);
        releases.push({ ...v, artifacts: undefined, files: v.artifacts.filter((a) => a.status !== "removed").length, mayApprove: may.approve, mayPublish: may.publish, mayPublication: may.publication });
      }
      return send(json(res, 200, { releases, auditIntact: auditIntact() }));
    }
    if (p === "/api/v1/publishing/compare" && m === "GET") {
      const a = release(url.searchParams.get("from") ?? "");
      const b = release(url.searchParams.get("to") ?? "");
      if (!a || !b) throw new HttpError(404, "not_found", "Not found.");
      if (a.product_id !== b.product_id) throw new HttpError(400, "different_products", "Compare releases of the same product.");
      if (!(await permitted(actor, "publish", a.product_id)) && !(await permitted(actor, "approve", a.product_id))) throw new HttpError(404, "not_found", "Not found.");
      return send(json(res, 200, compareReleases(releaseView(a, false), releaseView(b, false))));
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
                      requested_eligibility, destinations, status, created_by, created_at, updated_at, known_limitations, supersede_on_publish, upload_source, publication_request) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, input.productId, pinfo.source, input.editionId, input.version, input.build, input.channel, JSON.stringify(input.releaseNotes),
                 JSON.stringify(input.compatibility), input.distribution, input.eligibility, JSON.stringify(input.destinations), actor.sub, now(), now(),
                 JSON.stringify(input.knownLimitations), input.supersedePreviousOnPublish || input.publicationRequest?.supersedePrevious === "compatible" ? 1 : 0, JSON.stringify(uploadSourceOf(actor)),
                 input.publicationRequest ? JSON.stringify(input.publicationRequest) : null);
          audit(actor.sub, "release.draft-created", id, null, { productId: input.productId, editionId: input.editionId, version: input.version, build: input.build, eligibility: input.eligibility, distribution: input.distribution, channel: input.channel, supersedePreviousOnPublish: input.supersedePreviousOnPublish, ...(input.publicationRequest ? { publicationRequest: input.publicationRequest } : {}), via: actor.via, source: uploadSourceOf(actor) });
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
        if (!(await mayReview(actor, r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        return send(json(res, 200, { ...releaseView(r), auditIntact: auditIntact() }));
      }
      if (action === "/readiness" && m === "GET") {
        if (!(await mayReview(actor, r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        return send(json(res, 200, await readiness(r, actor)));
      }
      if (action === "" && m === "PATCH") {
        // Edit the release record (never its files). Changing a submitted or approved release returns it to draft: the
        // approval was for the record as it was.
        await requirePermission(actor, "publish", r.product_id);
        expectRevision(req, r);
        if (!["draft", "submitted", "approved"].includes(r.status)) throw new HttpError(409, "release_locked", `The release is ${r.status}; its record is final. Create a new build instead.`);
        const body = z.strictObject({
          releaseNotes: z.array(text).max(50).optional(),
          knownLimitations: z.array(text).max(30).optional(),
          compatibility: ReleaseInput.shape.compatibility.optional(),
          requestedEligibility: z.enum(["private", "internal-testing", "public"]).optional(),
          supersedePreviousOnPublish: z.boolean().optional(),
        }).parse(await readJson(req));
        const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
        if (!changed.length) throw new HttpError(400, "nothing_to_change", "Nothing to change.");
        transaction(db, () => {
          invalidate(actor.sub, r, "The release record was edited.");
          if (body.releaseNotes) db.prepare("UPDATE pub_releases SET release_notes = ? WHERE id = ?").run(JSON.stringify(body.releaseNotes), r.id);
          if (body.knownLimitations) db.prepare("UPDATE pub_releases SET known_limitations = ? WHERE id = ?").run(JSON.stringify(body.knownLimitations), r.id);
          if (body.compatibility) db.prepare("UPDATE pub_releases SET compatibility = ? WHERE id = ?").run(JSON.stringify(body.compatibility), r.id);
          if (body.requestedEligibility) db.prepare("UPDATE pub_releases SET requested_eligibility = ? WHERE id = ?").run(body.requestedEligibility, r.id);
          if (body.supersedePreviousOnPublish !== undefined) db.prepare("UPDATE pub_releases SET supersede_on_publish = ? WHERE id = ?").run(body.supersedePreviousOnPublish ? 1 : 0, r.id);
          db.prepare("UPDATE pub_releases SET updated_at = ? WHERE id = ?").run(now(), r.id);
          audit(actor.sub, "release.updated", r.id, null, { via: actor.via, fields: changed, previousStatus: r.status });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if ((action === "/reject" || action === "/request-changes") && m === "POST") {
        // Review decisions with a recorded reason. Reject ends the review track (the release is withdrawn, files and history
        // kept); request changes returns it to draft for the submitter to correct and submit again.
        await requirePermission(actor, "approve", r.product_id);
        expectRevision(req, r);
        const body = z.strictObject({ reason: text.max(1000) }).parse(await readJson(req));
        if (!["submitted", "approved"].includes(r.status)) throw new HttpError(409, "not_in_review", `Only a submitted or approved (unpublished) release can be ${action === "/reject" ? "rejected" : "returned for changes"}; this one is ${r.status}.`);
        transaction(db, () => {
          if (action === "/reject") {
            db.prepare("UPDATE pub_releases SET status = 'withdrawn', withdrawn_reason = ?, approved_eligibility = NULL, approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").run(`Rejected: ${body.reason}`, now(), r.id);
            audit(actor.sub, "release.rejected", r.id, null, { reason: body.reason, via: actor.via, previousStatus: r.status });
          } else {
            db.prepare("UPDATE pub_releases SET status = 'draft', submitted_at = NULL, approved_eligibility = NULL, approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").run(now(), r.id);
            audit(actor.sub, "release.changes-requested", r.id, null, { reason: body.reason, via: actor.via, previousStatus: r.status });
          }
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if (action === "/founder-exception" && m === "POST") {
        // The Founder records the founder-operated exception for their OWN release personally, on the website, when HCG
        // confirms the Founder policy centrally. Bound to these exact files; recorded with the Founder's identity, the
        // release, every file's SHA-256, the reason and the time; shown as "not an independent review". It is never a
        // permission (each step still needs its HCG permission) and never changes the mandatory signing requirements.
        if (actor.via !== "web") throw new HttpError(403, "browser_required", "A founder exception is recorded in the browser, signed in to HCG Store.");
        if (P.founderWebExceptions === "off") throw new HttpError(403, "founder_web_exceptions_off", "Founder exceptions on the website are switched off on this Store.");
        expectRevision(req, r);
        const body = z.strictObject({ confirm: z.string(), reason: text.max(1000), filesDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await readJson(req));
        const ready = await readiness(r, actor);
        if (!ready.steps.founderException.allowed) throw new HttpError(409, "founder_exception_not_allowed", ready.steps.founderException.reasons.join(" "));
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        if (body.filesDigest !== ready.governance.filesDigest) throw new HttpError(409, "files_changed", "The release's files changed since you reviewed them. Reload and review them again.");
        const founder = await centralFounder(actor);
        if (!founder.confirmed) throw new HttpError(403, "not_founder", "HCG does not confirm the Founder policy for your account and HCG Store.");
        const files = artifactsOf(r.id).filter((a) => a.status === "verified").map((a) => ({ fileName: a.file_name, sha256: a.sha256 }));
        const at = now();
        try {
          const ex = grantFounderException(db, {
            releaseId: r.id, subject: actor.sub, reason: body.reason, expectDigest: body.filesDigest,
            authorisedBy: `The Founder${founder.displayName ? ` (${founder.displayName})` : ""}, Founder policy confirmed by HCG at ${new Date(at).toISOString()}`,
            performedBy: "the Founder, personally, on the HCG Store website",
            auditActor: actor.sub,
            auditDetail: { via: "web", selfRecorded: true, centralBasis: "founder_owner_all_products", files, independentReview: false },
          }, at);
          return send(json(res, 201, { exception: ex, release: releaseView(release(r.id)!) }));
        } catch (e) {
          if (e instanceof ReleaseExceptionError) throw new HttpError(409, "founder_exception_refused", e.message);
          throw e;
        }
      }
      if (action === "/artifacts" && m === "POST") {
        await requirePermission(actor, "publish", r.product_id);
        expectRevision(req, r);
        if (!OPEN_FOR_FILES.has(r.status)) throw new HttpError(409, "release_locked", "Files can be added only before a release is published. Create a new build instead.");
        const input = ArtifactInput.parse(await readJson(req));
        const replaced = input.replaces ? artifact(input.replaces) : undefined;
        if (input.replaces && (!replaced || replaced.release_id !== r.id || !["verified", "rejected"].includes(replaced.status))) {
          throw new HttpError(400, "bad_replacement", "replaces must name a verified or rejected file of this release.");
        }
        const problems = checkDeclaration({ fileName: input.fileName, platform: input.platform, format: input.format, sizeBytes: input.sizeBytes, maxBytes: P.maxUploadBytes });
        if (input.buildProvider === "manual-upload" && (input.sourceCommit || input.toolchain)) {
          problems.push("A manual upload claims no source commit or toolchain. Attach a Release Passport to show build evidence instead.");
        }
        if (P.storageQuotaBytes !== null && storageUsed() + input.sizeBytes > P.storageQuotaBytes) {
          throw new HttpError(409, "quota_exceeded", `HCG Store's storage quota would be exceeded (${storageUsed()} of ${P.storageQuotaBytes} bytes used). Remove unused drafts or ask for more storage.`);
        }
        const duplicate = artifactsOf(r.id).find((x) => x.status !== "removed" && x.status !== "rejected" && (x.sha256 ?? x.declared_sha256) === input.sha256 && x.id !== input.replaces);
        if (duplicate) problems.push(`The same bytes are already in this release as ${duplicate.file_name}.`);
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
            invalidate(actor.sub, r, "A file was added or replaced.");
            if (replaced) {
              db.prepare("UPDATE pub_artifacts SET status = 'removed' WHERE id = ?").run(replaced.id);
              audit(actor.sub, "artifact.replaced", r.id, replaced.id, { sha256: replaced.sha256, replacedBy: id, note: "The stored file is kept (immutable); it is no longer part of the release." });
            }
            const provenance: Provenance = { sourceCommit: input.sourceCommit, buildProvider: input.buildProvider, toolchain: input.toolchain, validationReport: input.validationReport };
            db.prepare(`INSERT INTO pub_artifacts (id, release_id, file_name, platform, format, architectures, minimum_os, size_bytes, declared_sha256, status,
                        content_type, signing_reported, package, created_at, declared_kind, provenance) VALUES (?,?,?,?,?,?,?,?,?, 'awaiting-upload', ?, ?, ?, ?, ?, ?)`)
              .run(id, r.id, input.fileName, input.platform, input.format, JSON.stringify(input.architectures), input.minimumOs, input.sizeBytes, input.sha256,
                   CONTENT_TYPES[input.format], JSON.stringify({ ...input.signing, reportedBy: actor.via }), input.package ? JSON.stringify(input.package) : null, now(), input.kind,
                   JSON.stringify(provenance));
            db.prepare("INSERT INTO pub_uploads (artifact_id, received_bytes, staging_key, attempts, updated_at) VALUES (?, 0, ?, 0, ?)").run(id, `.uploads/${id}.part`, now());
            audit(actor.sub, "artifact.declared", r.id, id, { fileName: input.fileName, platform: input.platform, format: input.format, kind: input.kind, sizeBytes: input.sizeBytes, declaredSha256: input.sha256, signing: input.signing, provenance, replaces: input.replaces });
          });
        } catch (e) {
          if (String((e as Error).message).includes("UNIQUE")) throw new HttpError(409, "file_exists", `${input.fileName} is already part of this release. A replacement needs a new file name.`);
          throw e;
        }
        return send(json(res, 201, { artifact: artifactView(artifact(id)!), ...uploadUrl(id, actor.sub) }));
      }
      if (action === "/submit" && m === "POST") {
        await requirePermission(actor, "publish", r.product_id);
        expectRevision(req, r);
        // An imported release has no human creator: its submission is the accountable step, so it happens in the
        // browser, signed in, by a person (never by a desktop or CI token).
        if (r.imported_from && actor.via !== "web") throw new HttpError(403, "manual_submission_required", "An imported release is submitted by a person in HCG Store, not from an app.");
        if (r.status !== "draft") throw new HttpError(409, "not_draft", "Only a draft can be submitted.");
        const arts = artifactsOf(r.id);
        if (!arts.some((a) => a.status === "verified")) throw new HttpError(409, "no_files", "Upload and verify at least one file first.");
        if (arts.some((a) => ["awaiting-upload", "uploading"].includes(a.status))) throw new HttpError(409, "uploads_pending", "Finish or remove the uploads in progress first.");
        if ((JSON.parse(r.release_notes) as string[]).length === 0) throw new HttpError(409, "release_notes_required", "Add release notes before submitting.");
        const missing = arts.filter((a) => a.status === "verified").filter((a) => {
          const pv = a.provenance ? (JSON.parse(a.provenance) as Provenance) : null;
          if (pv?.buildProvider === "manual-upload") return false; // honest: no build evidence claimed (shown on the review page)
          return !pv?.sourceCommit || !pv.buildProvider || !pv.toolchain;
        });
        if (missing.length) {
          throw new HttpError(409, "provenance_required", `Every file needs its source commit, build provider and toolchain before submission, or must be declared a manual upload (no build evidence): ${missing.map((a) => a.file_name).join(", ")}. Upload it again with them (as a replacement).`);
        }
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
          audit(actor.sub, "release.submitted", r.id, null, { via: actor.via, files: arts.filter((a) => a.status === "verified").map((a) => ({ id: a.id, sha256: a.sha256 })) });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if ((action === "/approve" || action === "/publish") && m === "POST" && !P.publicationEnabled) {
        throw new HttpError(409, "publication_disabled", "This HCG Store accepts private uploads only: approval and publication are switched off (HCG_STORE_PUBLISHING=uploads). Your draft is kept privately.");
      }
      if ((action === "/approve" || action === "/publish") && m === "POST" && !publicationOn(r.product_id)) {
        throw new HttpError(409, "publication_disabled", "Approval and publication are not switched on for this product (HCG_STORE_PUBLICATION_PRODUCTS). Your draft is kept privately.");
      }
      if (action === "/approve" && m === "POST") {
        // Manual approval happens in HCG Store, signed in through the browser; a desktop token cannot approve.
        if (actor.via !== "web") throw new HttpError(403, "manual_approval_required", "Releases are approved manually in HCG Store, not from a desktop app.");
        await requirePermission(actor, "approve", r.product_id);
        expectRevision(req, r);
        // `current`: the approver also makes this the product's current release in the public catalogue (generated
        // from these records by `npm run releases:sync`; never inferred from the newest version).
        const parsed = z.strictObject({ eligibility: z.enum(["private", "internal-testing", "public"]), confirm: z.string(), current: z.boolean().optional() }).parse(await readJson(req));
        // Not given: what the submitter asked for (Distribution Studio "make current"), for a public approval only.
        const asked = r.publication_request ? (JSON.parse(r.publication_request) as { makeCurrent?: boolean }) : null;
        const body = { ...parsed, current: parsed.current ?? (parsed.eligibility === "public" && asked?.makeCurrent === true) };
        if (body.current && body.eligibility !== "public") throw new HttpError(400, "current_needs_public", "Only a release approved for public delivery can be the catalogue's current release.");
        if (!["submitted", "approved"].includes(r.status)) throw new HttpError(409, "not_submitted", "Only a submitted release can be approved.");
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        if (ELIGIBILITY_RANK[body.eligibility] > ELIGIBILITY_RANK[r.requested_eligibility as keyof typeof ELIGIBILITY_RANK]) throw new HttpError(400, "beyond_request", "Approval cannot exceed the eligibility the publisher requested.");
        if (body.eligibility === "public") {
          separationOrException(r, actor.sub, "approve");
          if (productInfo(r.product_id)?.source !== "catalogue" || !productInfo(r.product_id)?.centralId) {
            throw new HttpError(409, "not_in_catalogue", "Public release needs the product in HCG's catalogue with a confirmed central product ID.");
          }
          const signingProblems = publicSigningProblems(r.id);
          if (signingProblems.length) {
            throw new HttpError(409, "not_installable", `Public release refused: ${signingProblems.join(" ")} Approve it for private or internal testing, or ship correctly signed files. A founder exception never changes this.`);
          }
        }
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'approved', approved_eligibility = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(body.eligibility, actor.sub, now(), now(), r.id);
          const ex = body.eligibility === "public" ? activeException(db, r.id, actor.sub) : null;
          const sameParty = isSameParty(r, actor.sub);
          audit(actor.sub, "release.approved", r.id, null, { eligibility: body.eligibility, current: body.current, ...(sameParty && ex ? { governance: { exceptionId: ex.id, kind: ex.kind, artifactDigest: ex.artifactDigest, independentReview: false } } : {}) });
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if (action === "/publish" && m === "POST") {
        // Publication is a separate, explicit step after approval, by a person holding HCG's separate publication
        // permission, signed in through the browser, other than the person who created the release. Submitting files
        // or approving never implies it, and nothing is published automatically.
        if (actor.via !== "web") throw new HttpError(403, "manual_publication_required", "Releases are published manually in HCG Store, not from a desktop app.");
        await requirePermission(actor, "publication", r.product_id);
        expectRevision(req, r);
        // supersedePrevious (or the older "supersede"): replace the current release of each target this release
        // serves. Omitted: the choice prepared with the draft. Targets with no current release always become this one.
        // scope (Distribution Studio): "compatible" is how supersede always works now (per product, edition, platform,
        // architecture and channel). "edition" (retire every published release of the edition, whatever its platform
        // or channel) was removed: it retired unrelated platforms and channels.
        const body = z.strictObject({ confirm: z.string(), current: z.boolean().optional(), supersede: z.boolean().optional(), supersedePrevious: z.boolean().optional(), scope: z.enum(["edition", "compatible"]).optional() }).parse(await readJson(req));
        if (body.scope === "edition") throw new HttpError(400, "edition_scope_removed", "Superseding a whole edition is no longer supported: it retired other platforms, architectures and channels. Supersede replaces only the same platform, architecture and channel (scope \"compatible\").");
        if (r.status !== "approved") throw new HttpError(409, "not_approved", "Only an approved release can be published.");
        if (r.approved_eligibility !== "public") throw new HttpError(409, "not_public", "Only a release approved for public delivery is published. Internal-testing releases are delivered to testers once approved.");
        if (r.availability !== "available") throw new HttpError(409, "not_available", `This release is ${r.availability}; it cannot be published.`);
        const publishException = separationOrException(r, actor.sub, "publish");
        const signingAtPublication = publicSigningProblems(r.id);
        if (signingAtPublication.length) throw new HttpError(409, "not_installable", `Publication refused: ${signingAtPublication.join(" ")}`);
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        // Every required check BEFORE anything changes: the stored bytes must still be exactly the reviewed bytes.
        // A failed check changes nothing, so the previous release stays current and downloadable.
        const bad = await storedMismatches(r.id);
        if (bad.length) {
          transaction(db, () => audit(actor.sub, "release.publication-refused", r.id, null, { reason: "checksum-mismatch", files: bad }));
          throw new HttpError(409, "checksum_mismatch", `Publication refused: ${bad.map((b) => b.fileName).join(", ")} no longer match their recorded SHA-256. Nothing was changed; the previous release stays current.`);
        }
        if (!targetsOf(db, r).length) throw new HttpError(409, "no_customer_files", "This release has no file customers can receive (e.g. only an AAB).");
        const approval = db.prepare("SELECT detail FROM pub_audit WHERE action = 'release.approved' AND release_id = ? ORDER BY seq DESC LIMIT 1").get(r.id) as { detail: string } | undefined;
        const current = body.current ?? (approval ? (JSON.parse(approval.detail) as { current?: boolean }).current === true : false);
        const supersede = body.supersedePrevious ?? body.supersede ?? r.supersede_on_publish === 1;
        let sw: SwitchResult = { switched: [], kept: [], superseded: [] };
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'published', published_at = ?, published_by = ?, updated_at = ? WHERE id = ?").run(now(), actor.sub, now(), r.id);
          // The current-release switch happens in the same transaction as the publication: all or nothing.
          sw = switchCurrent(db, r, { supersede, at: now(), by: actor.sub });
          for (const old of sw.superseded) audit(actor.sub, "release.superseded", old, null, { supersededBy: r.id });
          audit(actor.sub, "release.published", r.id, null, { current, supersede, superseded: sw.superseded, targets: { switched: sw.switched, kept: sw.kept }, files: artifactsOf(r.id).filter((a) => a.status === "verified").map((a) => ({ id: a.id, sha256: a.sha256 })),
            ...(publishException ? { governance: { exceptionId: publishException.id, kind: publishException.kind, artifactDigest: publishException.artifactDigest, independentReview: false } } : {}) });
          startPublicationWindows(r.id, now());
          invalidateGrantsOf(sw.superseded);
        });
        return send(json(res, 200, { ...releaseView(release(r.id)!), switch: sw }));
      }
      if ((action === "/supersede" || action === "/restore") && m === "POST") {
        // Supersede: make an already published release the current one of its targets, retiring what it replaces.
        // Restore (rollback): make an earlier published release (superseded, disabled or archived, never revoked or
        // withdrawn) current again on its targets; the release it replaces becomes superseded. Both are publication decisions: a person with
        // HCG's publication permission, in the browser, typing the version; never automatic.
        if (!P.publicationEnabled) throw new HttpError(409, "publication_disabled", "This HCG Store accepts private uploads only: publication, supersede and restore are switched off.");
        if (!publicationOn(r.product_id)) throw new HttpError(409, "publication_disabled", "Publication is not switched on for this product (HCG_STORE_PUBLICATION_PRODUCTS).");
        if (actor.via !== "web") throw new HttpError(403, "manual_publication_required", "Supersede and restore happen in HCG Store in the browser, not from an app.");
        await requirePermission(actor, "publication", r.product_id);
        expectRevision(req, r);
        const body = z.strictObject({ confirm: z.string(), reason: z.string().trim().min(1).max(500) }).parse(await readJson(req));
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        if (!r.published_at || r.approved_eligibility !== "public" || !["published", "superseded"].includes(r.status)) throw new HttpError(409, "not_eligible", "Only a release that was published for the public (and not withdrawn) can be made current.");
        if (r.availability === "revoked") throw new HttpError(409, "revoked", "A revoked release can never be restored.");
        if (action === "/supersede" && r.status !== "published") throw new HttpError(409, "not_published", "Supersede applies to a published release; use restore for an earlier one.");
        const bad = await storedMismatches(r.id);
        if (bad.length) throw new HttpError(409, "checksum_mismatch", `Refused: ${bad.map((b) => b.fileName).join(", ")} no longer match their recorded SHA-256. Nothing was changed.`);
        let sw: SwitchResult = { switched: [], kept: [], superseded: [] };
        transaction(db, () => {
          if (r.availability !== "available") db.prepare("UPDATE pub_releases SET availability = 'available', availability_reason = NULL, updated_at = ? WHERE id = ?").run(now(), r.id);
          // Both replace the current release on every target this release serves; what is then current nowhere is
          // superseded (kept in the history, restorable).
          sw = switchCurrent(db, r, { supersede: true, at: now(), by: actor.sub });
          for (const old of sw.superseded) audit(actor.sub, "release.superseded", old, null, { supersededBy: r.id });
          audit(actor.sub, action === "/restore" ? "release.restored" : "release.made-current", r.id, null, { reason: body.reason, previousAvailability: r.availability, previousStatus: r.status, targets: sw.switched, superseded: sw.superseded });
          invalidateGrantsOf(sw.superseded);
        });
        return send(json(res, 200, { ...releaseView(release(r.id)!), switch: sw }));
      }
      if (["/disable", "/enable", "/archive", "/revoke"].includes(action) && m === "POST") {
        expectRevision(req, r);
        const body = z.strictObject({ reason: z.string().trim().min(1).max(500), confirm: z.string().optional() }).parse(await readJson(req));
        const may = { publish: await permitted(actor, "publish", r.product_id), approve: await permitted(actor, "approve", r.product_id), publication: await permitted(actor, "publication", r.product_id) };
        let next: string;
        if (action === "/disable") {
          // Stopping delivery is protective: anyone HCG lets submit, approve or publish this product may do it.
          if (!may.publish && !may.approve && !may.publication) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
          if (r.availability !== "available") throw new HttpError(409, "not_available", `This release is already ${r.availability}.`);
          next = "disabled";
        } else if (action === "/enable") {
          // Making a published release downloadable again is a publication decision.
          if (r.published_at) {
            if (!P.publicationEnabled) throw new HttpError(409, "publication_disabled", "This HCG Store accepts private uploads only: re-enabling a published release is switched off.");
            if (!publicationOn(r.product_id)) throw new HttpError(409, "publication_disabled", "Publication is not switched on for this product (HCG_STORE_PUBLICATION_PRODUCTS).");
            if (actor.via !== "web") throw new HttpError(403, "manual_publication_required", "Re-enabling a published release happens in HCG Store in the browser.");
            if (!may.publication) throw new HttpError(403, "not_publication", "HCG has not granted your account permission to publish approved releases.");
          } else if (!may.publish) throw new HttpError(403, "not_publisher", "HCG has not granted your account permission to submit releases of this product.");
          if (!["disabled", "archived"].includes(r.availability)) throw new HttpError(409, "not_disabled", r.availability === "revoked" ? "A revoked release can never be enabled again." : "This release is available.");
          next = "available";
        } else if (action === "/archive") {
          if (!may.publish && !may.approve) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
          if (r.availability === "revoked") throw new HttpError(409, "revoked", "A revoked release stays revoked.");
          if (r.availability === "archived") throw new HttpError(409, "already_archived", "Already archived.");
          if (currentTargetsOfRelease(db, r.id).length && r.status === "published" && r.availability === "available") {
            throw new HttpError(409, "is_current", "This release is current on at least one platform. Publish or restore another release there (or disable this one) before archiving it.");
          }
          next = "archived";
        } else {
          // Revocation is final (a database trigger refuses any way back): approvers or publishers, in the browser,
          // typing the version.
          if (actor.via !== "web") throw new HttpError(403, "manual_revocation_required", "Releases are revoked in HCG Store in the browser.");
          if (!may.approve && !may.publication) throw new HttpError(403, "not_approver", "HCG has not granted your account permission to approve or publish releases of this product.");
          if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm. Revocation cannot be undone.`);
          if (r.availability === "revoked") throw new HttpError(409, "already_revoked", "Already revoked.");
          next = "revoked";
        }
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET availability = ?, availability_reason = ?, updated_at = ? WHERE id = ?").run(next, next === "available" ? null : body.reason, now(), r.id);
          const cleared = next === "revoked" ? clearCurrent(db, r.id) : [];
          audit(actor.sub, `release.${action.slice(1)}d`, r.id, null, { reason: body.reason, previousAvailability: r.availability, availability: next, clearedTargets: cleared, via: actor.via });
          // Already issued download links are re-checked at use; drop them anyway so nothing outstanding refers to it.
          if (next !== "available") invalidateGrantsOf([r.id]);
        });
        return send(json(res, 200, releaseView(release(r.id)!)));
      }
      if (action === "/verify-checksums" && m === "POST") {
        if (!(await permitted(actor, "publish", r.product_id)) && !(await permitted(actor, "approve", r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        const results: { id: string; fileName: string; expected: string | null; actual: string | null; ok: boolean }[] = [];
        for (const a of artifactsOf(r.id).filter((x) => x.status === "verified")) {
          const file = stagingPath(a.storage_key!);
          const actual = existsSync(file) ? await hashFile(file) : null;
          results.push({ id: a.id, fileName: a.file_name, expected: a.sha256, actual, ok: actual === a.sha256 });
        }
        const ok = results.every((x) => x.ok);
        transaction(db, () => audit(actor.sub, "release.checksums-verified", r.id, null, { ok, files: results.map((x) => ({ id: x.id, ok: x.ok })) }));
        return send(json(res, ok ? 200 : 409, { ok, checkedAt: now(), files: results }));
      }
      if (action === "/requests" && m === "POST") {
        // Distribution Studio: a request for the people who approve and publish (desktop apps cannot supersede, restore
        // or re-enable; those are browser decisions). Recorded in the audit chain and shown in Release Manager and on the
        // review page. It changes nothing itself.
        if (!(await mayReview(actor, r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        expectRevision(req, r);
        const body = z.strictObject({ action: z.enum(["disable", "enable", "restore", "supersede", "make-current"]), reason: text.max(500), confirm: z.string() }).parse(await readJson(req));
        if (body.confirm !== r.version) throw new HttpError(400, "confirmation_required", `Type the version (${r.version}) to confirm.`);
        const targets = targetsOf(db, r);
        const currentOn = currentTargetsOfRelease(db, r.id).length;
        const why = (() => {
          if (r.availability === "revoked") return "This release was revoked; it can never be delivered again.";
          if (body.action === "disable") return r.availability !== "available" ? `This release is already ${r.availability}.` : !r.published_at ? "Only a published release is delivered; a draft is private already." : null;
          if (body.action === "enable") return !["disabled", "archived"].includes(r.availability) ? "This release is available." : null;
          if (!r.published_at || r.approved_eligibility !== "public" || !["published", "superseded"].includes(r.status)) return `Only a release that was published for the public (and not withdrawn) can be made current; this one is ${r.status}.`;
          if (currentOn >= targets.length && r.availability === "available") return "This release is already current on every platform it serves.";
          return null;
        })();
        if (why) throw new HttpError(409, body.action === "restore" ? "not_restorable" : "not_applicable", why);
        transaction(db, () => audit(actor.sub, "release.request", r.id, null, { action: body.action, reason: body.reason, via: actor.via, status: r.status, availability: r.availability }));
        return send(json(res, 202, { recorded: true, note: "Recorded for the people who approve and publish in HCG Store. Nothing changed.", requests: requestsOf(r.id) }));
      }
      if (action === "/withdraw" && m === "POST") {
        if (!(await permitted(actor, "publish", r.product_id)) && !(await permitted(actor, "approve", r.product_id))) throw new HttpError(403, "not_publisher", "HCG has not granted your account access to this release.");
        expectRevision(req, r);
        const body = z.strictObject({ reason: text.max(500) }).parse(await readJson(req));
        if (r.status === "withdrawn") throw new HttpError(409, "already_withdrawn", "Already withdrawn.");
        transaction(db, () => {
          db.prepare("UPDATE pub_releases SET status = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE id = ?").run(body.reason, now(), r.id);
          audit(actor.sub, "release.withdrawn", r.id, null, { reason: body.reason, previousStatus: r.status, previousEligibility: r.approved_eligibility });
          invalidateGrantsOf([r.id]);
          // A testing period waiting for this release's publication can never start now: end it, recorded.
          for (const w of db.prepare("SELECT id FROM free_windows WHERE release_id = ? AND starts_at IS NULL AND terminated_at IS NULL").all(r.id) as { id: string }[]) {
            db.prepare("UPDATE free_windows SET terminated_at = ?, terminated_reason = ? WHERE id = ?").run(now(), "The release was withdrawn before publication.", w.id);
            db.prepare("INSERT INTO free_window_events (at, window_id, action, detail, authorised_by, performed_by) VALUES (?, ?, ?, ?, ?, ?)")
              .run(now(), w.id, "window.terminated", JSON.stringify({ reason: "release withdrawn before publication", releaseId: r.id }), "release withdrawal", "HCG Store");
          }
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
      if (action === "/passport" && m === "POST") {
        // Build evidence for a file already verified in a DRAFT: an HCG Release Passport v1 that describes exactly these
        // bytes (name, size, SHA-256 and SHA-512 of the stored file). It never changes the file; it changes what reviewers
        // see, so it is accepted only before submission. Nothing in it is trusted beyond the match.
        await requirePermission(actor, "publish", r.product_id);
        if (r.status !== "draft") throw new HttpError(409, "not_draft", "Evidence can be attached only while the release is a draft.");
        if (a.status !== "verified" || !a.storage_key) throw new HttpError(409, "not_verified", "Attach a passport after HCG Store has verified the file.");
        const body = z.object({
          format: z.literal("hcg.release-passport"), formatVersion: z.literal(1),
          source: z.object({ repository: z.string().max(200).nullable().optional(), commit: z.string().regex(/^[a-f0-9]{7,40}$/).nullable().optional() }).passthrough().optional(),
          build: z.object({ provider: z.string().max(80).nullable().optional(), run_id: z.union([z.number().int(), z.string().regex(/^\d{1,20}$/)]).nullable().optional() }).passthrough().optional(),
          artifact: z.object({ filename: z.string(), size: z.number().int(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sha512: z.string().regex(/^[a-f0-9]{128}$/) }).passthrough(),
        }).passthrough().parse(await readJson(req));
        const file = stagingPath(a.storage_key);
        const sha512 = await (async () => { const h = createHash("sha512"); for await (const c of createReadStream(file)) h.update(c as Buffer); return h.digest("hex"); })();
        const wrong: string[] = [];
        if (body.artifact.filename !== a.file_name) wrong.push(`describes ${body.artifact.filename}, not ${a.file_name}`);
        if (body.artifact.size !== a.size_bytes) wrong.push("size differs");
        if (body.artifact.sha256 !== a.sha256) wrong.push("SHA-256 differs");
        if (body.artifact.sha512 !== sha512) wrong.push("SHA-512 differs");
        if (wrong.length) throw new HttpError(422, "passport_mismatch", `The Release Passport does not describe this file: ${wrong.join("; ")}.`);
        const passport = { commit: body.source?.commit ?? null, repository: body.source?.repository ?? null, provider: body.build?.provider ?? null, runId: body.build?.run_id != null ? String(body.build.run_id) : null, sha512 };
        const prov = { ...(a.provenance ? (JSON.parse(a.provenance) as Provenance) : {}), passport } as Provenance & { passport: typeof passport };
        transaction(db, () => {
          db.prepare("UPDATE pub_artifacts SET provenance = ? WHERE id = ?").run(JSON.stringify(prov), a.id);
          audit(actor.sub, "artifact.passport-attached", r.id, a.id, { passport });
        });
        return send(json(res, 200, { artifact: artifactView(artifact(a.id)!) }));
      }
      if (action === "" && m === "DELETE") {
        expectRevision(req, r);
        if (!OPEN_FOR_FILES.has(r.status)) throw new HttpError(409, "release_locked", "Files can be removed only before a release is published. Withdraw the release instead.");
        if (a.status === "verified") {
          transaction(db, () => {
            invalidate(actor.sub, r, "A file was removed.");
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
      if (!r || !(await mayReview(actor, r.product_id))) throw new HttpError(404, "not_found", "Not found.");
      return send(reviewPage(res, releaseView(r), await permitted(actor, "approve", r.product_id), await permitted(actor, "publication", r.product_id), await permitted(actor, "publish", r.product_id), actor.csrf ?? ""));
    }
    throw new HttpError(404, "not_found", "Not found.");

    function send(_: void) { return true; }
  }

  async function serveDownload(res: ServerResponse, token: string) {
    const g = db.prepare("SELECT * FROM pub_download_grants WHERE id_hash = ?").get(sha256Hex(token)) as { sub: string; artifact_id: string; access_token: string | null; expires_at: number } | undefined;
    if (!g) return errorJson(res, 403, "link_expired", "This download link has expired.");
    if (g.expires_at < now()) {
      // A link cut short because its release was stopped says why.
      const st = artifact(g.artifact_id) ? release(artifact(g.artifact_id)!.release_id) : undefined;
      const why = st?.status === "withdrawn" ? "withdrawn" : st && st.availability !== "available" ? st.availability : st?.status === "superseded" ? "superseded" : null;
      if (g.expires_at === 0 && why) return errorJson(res, 410, why, `This release is ${why}.`);
      return errorJson(res, 403, "link_expired", "This download link has expired.");
    }
    const a = artifact(g.artifact_id);
    if (!a) return errorJson(res, 404, "not_found", "Not found.");
    // Re-checked at use: a withdrawal or a revoked entitlement applies even inside the link's lifetime.
    const d = await authorizeDownload({ sub: g.sub, accessToken: g.access_token ? unseal(cfg.secretKey, g.access_token, "pub-download") : null }, a);
    if (!d.ok) return errorJson(res, d.status, d.code, d.message);
    audit(g.sub, "artifact.downloaded", a.release_id, a.id, { basis: d.basis });
    return deps.streamArtifact(res, a.storage_key!, a.file_name, a.content_type);
  }

  /** How a file says it was built, exactly as reported; a manual upload claims nothing. */
  function provenanceLabel(pv: (Provenance & { passport?: { commit: string | null; provider: string | null; runId: string | null } }) | null): string {
    const e = escapeHtml;
    if (!pv) return "—";
    const parts: string[] = [];
    if (pv.buildProvider === "manual-upload") parts.push('<span class="warn">Manual upload: no build evidence</span>');
    else if (pv.buildProvider) parts.push(`${e(pv.buildProvider)}${pv.sourceCommit ? ` @ <code>${e(pv.sourceCommit.slice(0, 12))}</code>` : ""}`);
    if (pv.passport) parts.push(`Release Passport matched${pv.passport.provider ? ` (${e(pv.passport.provider)}${pv.passport.runId ? ` run ${e(pv.passport.runId)}` : ""}${pv.passport.commit ? `, ${e(pv.passport.commit.slice(0, 12))}` : ""})` : ""}`);
    return parts.join("<br>") || "—";
  }

  function reviewPage(res: ServerResponse, r: ReturnType<typeof releaseView>, canApprove: boolean, canPublishRelease = false, canSubmit = false, csrf = "") {
    const e = escapeHtml;
    // Inline scripts run only with this response's nonce; fetches go to the Store itself.
    const nonce = randomBytes(16).toString("base64");
    // Every change from this page sends the session's CSRF token (X-HCG-CSRF), read from this meta element.
    const H = `{'content-type':'application/json','x-hcg-csrf':document.querySelector('meta[name=hcg-csrf]').content}`;
    const submit = canSubmit && r.status === "draft" && r.artifacts.some((a) => a.status === "verified")
      ? `<form id="submit"><p><b>Submit for approval.</b> You confirm these exact files and this text are what should be reviewed. Submitting is recorded under your account; it does not approve or publish anything.</p><button>Submit for approval</button></form>
         <script nonce="${nonce}">document.getElementById('submit').onsubmit=async(ev)=>{ev.preventDefault();const r=await fetch(location.pathname.replace('/publishing/','/api/v1/publishing/')+'/submit',{method:'POST',headers:${H},body:'{}'});const j=await r.json();alert(r.ok?'Submitted':j.message);location.reload();};</script>`
      : "";
    const governance = r.exceptions.length
      ? `<div style="border:2px solid #8a4b00;padding:.6rem 1rem;margin:1rem 0"><p><b>Founder-operated release exception.</b> One person may submit, approve and publish this release with exactly these files. This is <b>not</b> an independent review: no second person checks it, and the CI build is not a reviewer.</p><ul>${r.exceptions.map((x) => `<li><code>${e(x.id)}</code> · ${x.revokedAt ? `revoked ${new Date(x.revokedAt).toISOString()} (${e(x.revokedReason ?? "")})` : x.appliesToCurrentFiles ? "applies to the current files" : "<b>does not apply</b>: the files changed"} · files digest <code>${e(x.artifactDigest.slice(0, 16))}…</code> · reason: ${e(x.reason)} · authorised by ${e(x.authorisedBy)}, recorded by ${e(x.performedBy)}</li>`).join("")}</ul></div>`
      : "";
    const kindName: Record<string, string> = { installer: "Installer", "portable-app": "Portable app", "device-build": "iOS device build", "simulator-build": "iOS Simulator build", "jailbreak-package": "Jailbreak package" };
    const rows = r.artifacts.map((a) => `<tr><td>${e(a.fileName)}</td><td>${e(a.platform)} · ${e(a.format)}</td><td>${e(kindName[a.kind ?? ""] ?? "—")}${a.kindCheckedByStore ? "" : " (declared)"}</td><td>${a.sizeBytes}</td><td><code>${e(a.sha256 ?? a.declaredSha256)}</code></td><td>${e(a.status)}</td><td>${e(a.validation?.signatureStructure ?? "—")} / reported: ${e(a.signingReported.status)}</td><td class="${a.readiness.ordinaryInstall ? "ok" : "warn"}">${e(a.readiness.label)}</td><td>${provenanceLabel(a.provenance)}</td><td>${a.status === "verified" && r.status !== "withdrawn" ? `<button class="dl" data-id="${e(a.id)}">Download to review</button>` : ""}</td></tr>`).join("");
    const download = `<script nonce="${nonce}">document.querySelectorAll('button.dl').forEach(b=>b.onclick=async()=>{const r=await fetch('/api/v1/publishing/artifacts/'+b.dataset.id+'/download-url',{method:'POST',headers:${H},body:'{}'});const j=await r.json();if(r.ok)location.href=j.url;else alert(j.message);});</script>`;
    const approve = canApprove && ["submitted", "approved"].includes(r.status)
      ? `<form id="approve"><p>Manual approval. Requested: <b>${e(r.requestedEligibility)}</b>.</p><select name="eligibility"><option>private</option><option>internal-testing</option><option>public</option></select>
         <label><input type="checkbox" name="current"> Public only: make this the product's current release in the catalogue</label>
         <label>Type the version to confirm <input name="confirm" autocomplete="off"></label><button>Approve</button></form>
         <script nonce="${nonce}">document.getElementById('approve').onsubmit=async(ev)=>{ev.preventDefault();const f=new FormData(ev.target);const r=await fetch(location.pathname.replace('/publishing/','/api/v1/publishing/')+'/approve',{method:'POST',headers:${H},body:JSON.stringify({eligibility:f.get('eligibility'),confirm:f.get('confirm'),current:f.get('current')==='on'})});const j=await r.json();alert(r.ok?'Approved: '+j.approvedEligibility:j.message);location.reload();};</script>`
      : "";
    return html(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="hcg-csrf" content="${e(csrf)}"><title>Release review · HCG Store</title>
      <style>body{font:15px system-ui;margin:2rem;max-width:72rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;font-size:13px}code{font-size:12px}.ok{color:#176b2c}.warn{color:#8a4b00}</style></head><body>
      <h1>${e(r.productTitle)} ${e(r.version)} (build ${e(r.build)})</h1>
      <p>Status: <b>${e(r.status)}</b>${r.approvedEligibility ? ` · approved for <b>${e(r.approvedEligibility)}</b>` : ""} · requested: ${e(r.requestedEligibility)} · distribution: ${e(r.distribution)} · channel: ${e(r.channel)} · destinations: ${e(r.destinations.join(", "))}${r.productSource === "draft" ? " · <b>draft product</b> (not in the catalogue)" : ""}</p>
      ${r.importedFrom ? `<p>Imported unchanged from <b>${e(String(r.importedFrom.repository))}</b> commit <code>${e(String(r.importedFrom.commit))}</code>, CI run ${e(String(r.importedFrom.runId))}; every file matched its draft SHA-256 and Release Passport. Import authorised by ${e(String(r.importedFrom.authorisedBy))}, performed by ${e(String(r.importedFrom.performedBy))}. The CI build is recorded as the creator; it is not a reviewer. The person who submits it may not approve or publish it unless a founder-operated exception is recorded below.</p>` : ""}
      ${governance}
      ${r.releaseNotes.length ? `<h2>Release notes</h2><ul>${r.releaseNotes.map((n: string) => `<li>${e(n)}</li>`).join("")}</ul>` : ""}
      ${r.knownLimitations.length ? `<h2>Known limitations</h2><ul>${r.knownLimitations.map((n: string) => `<li>${e(n)}</li>`).join("")}</ul>` : ""}
      ${r.withdrawnReason ? `<p>Withdrawn: ${e(r.withdrawnReason)}</p>` : ""}
      ${r.requests.length ? `<h2>Requests</h2><ul>${r.requests.map((q) => `<li>${e(String(q.action))}: ${e(String(q.reason))} (account …${e(String(q.by).slice(-6))}, ${new Date(q.at).toISOString()}${q.via ? `, ${e(String(q.via))}` : ""})</li>`).join("")}</ul><p>Requests change nothing; the people who approve and publish decide.</p>` : ""}
      ${r.publicationRequest ? `<p>At publication, the submitter asks: ${r.publicationRequest.makeCurrent ? "make this the catalogue's current release" : "do not make it the catalogue's current release"}; ${r.publicationRequest.supersedePrevious === "compatible" ? "supersede the previous compatible release (same platform, architecture and channel)" : "supersede nothing"}.${r.publicationRequest.note ? ` Note: ${e(String(r.publicationRequest.note))}` : ""}</p>` : ""}
      <h2>Compatibility</h2><pre>${e(JSON.stringify(r.compatibility, null, 2))}</pre>
      <h2>Files</h2><table><tr><th>File</th><th>Platform</th><th>Kind</th><th>Bytes</th><th>SHA-256</th><th>Status</th><th>Signature (structure / reported)</th><th>Installation</th><th>Provenance (reported)</th><th></th></tr>${rows}</table>
      <p>Signature and notarisation results are reported by the uploading tool; HCG Store checks hashes, formats and archive safety only. A draft is visible only to the people HCG allows to publish or approve this product; uploading never makes a file public.</p>${download}
      ${submit}
      ${approve}
      ${canPublishRelease && r.status === "approved" && r.approvedEligibility === "public"
        ? `<form id="publish"><p><b>Publish.</b> Approved for public delivery but not delivered yet. Publishing is a separate, explicit step; nothing is published automatically.</p>
           <label><input type="checkbox" name="supersede"${r.supersedePreviousOnPublish ? " checked" : ""}> Supersede the previous compatible release (only the same platform, architecture and channel; other platforms, architectures and channels are kept)</label>
           <label>Type the version to confirm <input name="confirm" autocomplete="off"></label><button>Publish</button></form>
           <script nonce="${nonce}">document.getElementById('publish').onsubmit=async(ev)=>{ev.preventDefault();const f=new FormData(ev.target);const r=await fetch(location.pathname.replace('/publishing/','/api/v1/publishing/')+'/publish',{method:'POST',headers:${H},body:JSON.stringify({confirm:f.get('confirm'),supersede:f.get('supersede')==='on'})});const j=await r.json();alert(r.ok?'Published':j.message);location.reload();};</script>`
        : ""}
      <h2>Audit</h2><ol>${(r.audit ?? []).map((a) => `<li>${new Date(a.at).toISOString()} · ${e(a.action)} · ${e(a.actor)}</li>`).join("")}</ol>
      </body></html>`, {
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    });
  }

  /**
   * Operator import of a release built by a product's CI (release-import-cli.ts). The files are imported exactly as
   * built: each must match the draft's size and SHA-256 and, when given, its HCG Release Passport (SHA-256, SHA-512,
   * size, source commit, run), and then passes the same content checks as an upload. The result is a private
   * DRAFT whose creator is recorded as the CI build (`import:<repository>#<run>`). A person HCG allows to publish
   * submits it, a person allowed to approve approves it, and a person allowed to publish releases publishes it, each in
   * the browser and each audited. The CI build never counts as one of those people. Nothing is submitted, approved or
   * published here.
   */
  async function importRelease(opts: {
    draft: { release: unknown; artifacts: unknown[] };
    filesDir: string;
    passports: Record<string, { artifact: { filename: string; size: number; sha256: string; sha512: string }; source: { commit: string }; build: { run_id: number } }>;
    /**
     * ci-run: a product CI run with its HCG Store draft and Release Passports (every file must match its passport).
     * github-release: files a person built and attached to a GitHub release. There is no CI run and no passport, so
     * none is claimed: every file must be declared a manual upload (no source commit, build provider or toolchain),
     * and the review page shows it as such. The tag's commit is recorded as what the tag points to, not as build proof.
     */
    source:
      | { kind?: "ci-run"; repository: string; commit: string; runId: number }
      | { kind: "github-release"; repository: string; tag: string; tagCommit: string; evidenceRun: number | null };
    requestedEligibility: "private" | "internal-testing" | "public";
    knownLimitations: string[];
    authorisedBy: string;
    performedBy: string;
  }) {
    if (!P.enabled) throw new HttpError(409, "publishing_disabled", "Publishing is not enabled on this Store.");
    if (!opts.authorisedBy.trim() || !opts.performedBy.trim()) throw new HttpError(400, "who", "Record who authorised and who performed the import.");
    const input = ReleaseInput.parse({ ...(opts.draft.release as object), eligibility: opts.requestedEligibility, knownLimitations: opts.knownLimitations });
    const pinfo = productInfo(input.productId);
    if (!pinfo || pinfo.source !== "catalogue") throw new HttpError(404, "unknown_product", "Imports are for catalogue products only.");
    if (pinfo.editions.length ? !input.editionId || !pinfo.editions.includes(input.editionId) : input.editionId !== null) throw new HttpError(400, "bad_edition", "Unknown edition.");
    const files = opts.draft.artifacts.map((x) => ArtifactInput.parse(x));
    const problems: string[] = [];
    const sha = (path: string, algo: string) => createHash(algo).update(readFileSync(path)).digest("hex");
    for (const f of files) {
      problems.push(...checkDeclaration({ fileName: f.fileName, platform: f.platform, format: f.format, sizeBytes: f.sizeBytes, maxBytes: P.maxUploadBytes }).map((x) => `${f.fileName}: ${x}`));
      const path = resolve(opts.filesDir, f.fileName);
      if (!path.startsWith(resolve(opts.filesDir) + sep) || !existsSync(path)) { problems.push(`${f.fileName}: not in the import folder.`); continue; }
      const size = statSync(path).size;
      const sha256 = sha(path, "sha256");
      if (size !== f.sizeBytes) problems.push(`${f.fileName}: ${size} bytes, the draft says ${f.sizeBytes}.`);
      if (sha256 !== f.sha256) problems.push(`${f.fileName}: SHA-256 ${sha256}, the draft says ${f.sha256}.`);
      if (REJECTED_SHA256.has(sha256)) problems.push(`${f.fileName}: HCG Store refused this exact file earlier (rejected-artifacts.json); it is never imported.`);
      const src = opts.source;
      if (src.kind === "github-release") {
        // No build evidence exists for a hand-built file: claim none.
        if (f.buildProvider !== "manual-upload" || f.sourceCommit || f.toolchain) problems.push(`${f.fileName}: a GitHub release import has no build evidence, so the file must be declared a manual upload with no source commit or toolchain.`);
        if (opts.passports[f.fileName]) problems.push(`${f.fileName}: a GitHub release import takes no Release Passport.`);
        continue;
      }
      if (f.sourceCommit !== src.commit) problems.push(`${f.fileName}: built from ${f.sourceCommit}, the import names ${src.commit}.`);
      const pp = opts.passports[f.fileName];
      if (!pp) problems.push(`${f.fileName}: no Release Passport.`);
      else {
        if (pp.artifact.size !== size || pp.artifact.sha256 !== sha256 || pp.artifact.sha512 !== sha(path, "sha512")) problems.push(`${f.fileName}: the Release Passport does not match the file.`);
        if (pp.source.commit !== src.commit || Number(pp.build.run_id) !== Number(src.runId)) problems.push(`${f.fileName}: the Release Passport names another commit or run.`);
      }
    }
    if (!files.length) problems.push("The draft lists no files.");
    if (problems.length) throw new HttpError(400, "import_refused", problems.join(" "));

    const creator = opts.source.kind === "github-release" ? `import:${opts.source.repository}@${opts.source.tag}` : `import:${opts.source.repository}#${opts.source.runId}`;
    const importedFrom = { ...opts.source, authorisedBy: opts.authorisedBy.trim(), performedBy: opts.performedBy.trim(), draftRequestedEligibility: (opts.draft.release as { eligibility?: string }).eligibility ?? null };
    const id = `rel-${randomBytes(8).toString("hex")}`;
    transaction(db, () => {
      db.prepare(`INSERT INTO pub_releases (id, product_id, product_source, edition_id, version, build, channel, release_notes, compatibility, distribution,
                  requested_eligibility, destinations, status, created_by, created_at, updated_at, known_limitations, imported_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?)`)
        .run(id, input.productId, pinfo.source, input.editionId, input.version, input.build, input.channel, JSON.stringify(input.releaseNotes),
             JSON.stringify(input.compatibility), input.distribution, input.eligibility, JSON.stringify(input.destinations), creator, now(), now(),
             JSON.stringify(input.knownLimitations), JSON.stringify(importedFrom));
      audit(creator, "release.imported", id, null, { productId: input.productId, editionId: input.editionId, version: input.version, build: input.build, requestedEligibility: input.eligibility, distribution: input.distribution, ...importedFrom });
    });
    for (const f of files) {
      const aid = `art-${randomBytes(8).toString("hex")}`;
      const stagingKey = `.uploads/${aid}.part`;
      mkdirSync(dirname(stagingPath(stagingKey)), { recursive: true });
      copyFileSync(resolve(opts.filesDir, f.fileName), stagingPath(stagingKey));
      const provenance: Provenance = { sourceCommit: f.sourceCommit, buildProvider: f.buildProvider, toolchain: f.toolchain, validationReport: f.validationReport };
      transaction(db, () => {
        db.prepare(`INSERT INTO pub_artifacts (id, release_id, file_name, platform, format, architectures, minimum_os, size_bytes, declared_sha256, status,
                    content_type, signing_reported, package, created_at, declared_kind, provenance) VALUES (?,?,?,?,?,?,?,?,?, 'uploading', ?, ?, ?, ?, ?, ?)`)
          .run(aid, id, f.fileName, f.platform, f.format, JSON.stringify(f.architectures), f.minimumOs, f.sizeBytes, f.sha256, CONTENT_TYPES[f.format],
               JSON.stringify({ ...f.signing, reportedBy: "import" }), f.package ? JSON.stringify(f.package) : null, now(), f.kind, JSON.stringify(provenance));
        db.prepare("INSERT INTO pub_uploads (artifact_id, received_bytes, staging_key, attempts, updated_at) VALUES (?, ?, ?, 0, ?)").run(aid, f.sizeBytes, stagingKey, now());
        audit(creator, "artifact.declared", id, aid, { fileName: f.fileName, platform: f.platform, format: f.format, kind: f.kind, sizeBytes: f.sizeBytes, declaredSha256: f.sha256, signing: f.signing, provenance, via: "import" });
      });
      const out = await finalize(creator, artifact(aid)!);
      if (out.status !== 200) throw new HttpError(422, "import_rejected", `${f.fileName}: ${String((out.body as { message?: string }).message ?? "rejected")} The draft ${id} keeps the evidence and is not submitted.`);
    }
    if (!input.releaseNotes.length) throw new HttpError(409, "release_notes_required", "The draft has no release notes.");
    // Left as a DRAFT: a person HCG allows to publish (store.publish) submits it in HCG Store. The CI build is the
    // creator, never a reviewer.
    return releaseView(release(id)!);
  }

  /**
   * The live current releases of a catalogue product: for each distribution target (edition, platform, architecture,
   * channel) the release a person explicitly made current (publication, supersede or restore), when it is published,
   * public and available. Several releases can be current at once (e.g. Windows 2.0 and macOS 2.1); each lists only
   * the files of its current targets. Public metadata only: no storage location, account or audit data.
   */
  function currentPublishedFor(productId: string) {
    if (findProduct(registry, productId) === undefined) return [];
    const rows = currentRowsForProduct(db, productId);
    const byRelease = new Map<string, typeof rows>();
    for (const c of rows) byRelease.set(c.release_id, [...(byRelease.get(c.release_id) ?? []), c]);
    const out = [];
    for (const [releaseId, targets] of byRelease) {
      const r = release(releaseId);
      if (!r || r.product_source !== "catalogue" || r.status !== "published" || r.approved_eligibility !== "public" || r.availability !== "available") continue;
      const onTarget = (a: ArtifactRow) => {
        const archs = JSON.parse(a.architectures) as string[];
        return (archs.length ? archs : ["any"]).some((arch) => targets.some((t) => t.platform === a.platform && t.arch === arch));
      };
      out.push({
        releaseId: r.id, editionId: r.edition_id, version: r.version, build: r.build, channel: r.channel, distribution: r.distribution,
        publishedAt: r.published_at!, releaseNotes: JSON.parse(r.release_notes) as string[], knownLimitations: JSON.parse(r.known_limitations ?? "[]") as string[],
        targets: targets.map((t) => ({ platform: t.platform, arch: t.arch, channel: t.channel })),
        files: artifactsOf(r.id).filter((a) => a.status === "verified" && !STAFF_ONLY_FORMATS.has(a.format) && onTarget(a)).map((a) => {
          const v = artifactView(a);
          return { id: v.id, fileName: v.fileName, platform: v.platform, format: v.format, kind: v.kind ?? null, architectures: v.architectures as string[], minimumOs: v.minimumOs, sizeBytes: v.sizeBytes, sha256: v.sha256!, signing: String(v.signingReported.status) };
        }),
      });
    }
    return out.sort((a, b) => b.publishedAt - a.publishedAt || a.releaseId.localeCompare(b.releaseId));
  }

  /** What a product page may say about free testing (no account data): when the open window ends. */
  function freeWindowFor(productId: string, editionId: string | null): { endsAt: number; releaseId: string | null } | null {
    if (!P.publicationEnabled || !cfg.freeDownloads) return null;
    const b = freeBasis(productId, editionId);
    if (b?.kind !== "window" || b.window.endsAt === null) return null;
    // Only announce free testing when the window actually delivers something now: a published, public, free release
    // it covers (the named release, or any when it names none).
    if (!freePublicFor(productId, editionId).length) return null;
    return { endsAt: b.window.endsAt, releaseId: b.window.releaseId };
  }

  // The same identity, CSRF and HCG permission checks for HCG Store's other administration areas (commerce-admin.ts).
  const admin = { actorOf, assertCsrf, permitted, centralFounder };
  return { route, publishedFor, freePublicFor, freeWindowFor, currentPublishedFor, publishedById, publishedMeta, auditIntact, importRelease, allowedFormats: ALLOWED, admin };
}

type ReleaseViewLike = {
  id: string; version: string; build: string; channel: string; editionId: string | null; status: string; stage: string; releaseNotes: string[];
  artifacts: { id: string; fileName: string; platform: string; format: string; architectures: string[]; sizeBytes: number; sha256: string | null; status: string; provenance: unknown }[];
};

/** Differences between two releases of one product: fields, release notes, and files matched by platform, format and architectures. */
export function compareReleases(a: ReleaseViewLike, b: ReleaseViewLike) {
  const fields = (["version", "build", "channel", "editionId", "status", "stage"] as const)
    .filter((k) => a[k] !== b[k]).map((k) => ({ field: k, from: a[k], to: b[k] }));
  const key = (x: ReleaseViewLike["artifacts"][number]) => `${x.platform}|${x.format}|${[...x.architectures].sort().join(",")}`;
  const live = (r: ReleaseViewLike) => new Map(r.artifacts.filter((x) => x.status === "verified").map((x) => [key(x), x]));
  const from = live(a), to = live(b);
  const files = [];
  for (const [k, x] of to) {
    const y = from.get(k);
    if (!y) files.push({ change: "added", platform: x.platform, format: x.format, architectures: x.architectures, to: { fileName: x.fileName, sizeBytes: x.sizeBytes, sha256: x.sha256 } });
    else if (y.sha256 !== x.sha256) {
      files.push({ change: "changed", platform: x.platform, format: x.format, architectures: x.architectures, from: { fileName: y.fileName, sizeBytes: y.sizeBytes, sha256: y.sha256, provenance: y.provenance }, to: { fileName: x.fileName, sizeBytes: x.sizeBytes, sha256: x.sha256, provenance: x.provenance }, sizeDelta: x.sizeBytes - y.sizeBytes });
    } else files.push({ change: "identical", platform: x.platform, format: x.format, architectures: x.architectures, to: { fileName: x.fileName, sizeBytes: x.sizeBytes, sha256: x.sha256 } });
  }
  for (const [k, y] of from) if (!to.has(k)) files.push({ change: "removed", platform: y.platform, format: y.format, architectures: y.architectures, from: { fileName: y.fileName, sizeBytes: y.sizeBytes, sha256: y.sha256 } });
  return {
    from: { id: a.id, version: a.version, build: a.build }, to: { id: b.id, version: b.version, build: b.build },
    fields,
    releaseNotes: { added: b.releaseNotes.filter((n) => !a.releaseNotes.includes(n)), removed: a.releaseNotes.filter((n) => !b.releaseNotes.includes(n)) },
    files,
  };
}
