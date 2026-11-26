/**
 * Release lifecycle and explicit current releases.
 *
 * A release has three independent dimensions (never forced into one enum):
 *   - review/publication (pub_releases.status): draft → submitted → approved → published, or withdrawn; "superseded"
 *     marks a published release that a newer one replaced on every target it served;
 *   - availability (pub_releases.availability): available · disabled (stopped, restorable) · archived (kept for the
 *     record, hidden from ordinary lists) · revoked (stopped for good; a database trigger refuses any way back);
 *   - currency (pub_current): which release is the CURRENT one of each distribution target.
 *
 * A distribution target is (product, edition, platform, architecture, channel). A release serves the targets of its
 * verified customer files: a Windows x64 EXE and MSI of 2.0.0 serve one target; a macOS universal ZIP serves
 * (macos, arm64) and (macos, x64). Several installer formats of one release coexist on the same target. Publishing a
 * macOS update never touches Windows targets, an ARM64 build never touches x64, and a beta never touches stable,
 * because each only switches its own targets. Version numbers never decide what is current: a person's explicit
 * choice (publication, supersede or restore) does, and it is recorded in the audit chain.
 *
 * Customers are offered only files of releases that are current on their target, published, available and approved
 * for public delivery. Superseded, disabled, archived, revoked and withdrawn releases stay in the administrative
 * history with their files (which are immutable and never deleted).
 */
import type { Db } from "./db";
import { STAFF_ONLY_FORMATS } from "./artifact-validation";

export const AVAILABILITY = ["available", "disabled", "archived", "revoked"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface Target {
  productId: string;
  editionKey: string;
  platform: string;
  arch: string;
  channel: string;
}

export const targetKey = (t: Target) => `${t.productId}|${t.editionKey}|${t.platform}|${t.arch}|${t.channel}`;

type ReleaseLite = { id: string; product_id: string; edition_id: string | null; channel: string };

/** Targets a release serves: one per (platform, architecture) of its verified customer files ("any" when none named). */
export function targetsOf(db: Db, r: ReleaseLite): Target[] {
  const rows = db
    .prepare("SELECT platform, format, architectures FROM pub_artifacts WHERE release_id = ? AND status = 'verified'")
    .all(r.id) as { platform: string; format: string; architectures: string }[];
  const out = new Map<string, Target>();
  for (const a of rows) {
    if (STAFF_ONLY_FORMATS.has(a.format)) continue;
    const archs = JSON.parse(a.architectures) as string[];
    for (const arch of archs.length ? archs : ["any"]) {
      const t = { productId: r.product_id, editionKey: r.edition_id ?? "", platform: a.platform, arch, channel: r.channel };
      out.set(targetKey(t), t);
    }
  }
  return [...out.values()];
}

export interface CurrentRow {
  product_id: string; edition_key: string; platform: string; arch: string; channel: string; release_id: string; selected_at: number; selected_by: string;
}

export function currentOf(db: Db, t: Target): CurrentRow | undefined {
  return db
    .prepare("SELECT * FROM pub_current WHERE product_id = ? AND edition_key = ? AND platform = ? AND arch = ? AND channel = ?")
    .get(t.productId, t.editionKey, t.platform, t.arch, t.channel) as CurrentRow | undefined;
}

export function currentRowsForProduct(db: Db, productId: string): CurrentRow[] {
  return db.prepare("SELECT * FROM pub_current WHERE product_id = ? ORDER BY edition_key, platform, arch, channel").all(productId) as unknown as CurrentRow[];
}

export function currentTargetsOfRelease(db: Db, releaseId: string): CurrentRow[] {
  return db.prepare("SELECT * FROM pub_current WHERE release_id = ? ORDER BY platform, arch, channel").all(releaseId) as unknown as CurrentRow[];
}

export interface SwitchResult {
  /** Targets this release became current on, with the release it replaced (null: the target had none). */
  switched: { target: Target; previous: string | null }[];
  /** Targets left on another release because supersede was not chosen. */
  kept: { target: Target; current: string }[];
  /** Releases that are no longer current anywhere and were marked superseded. */
  superseded: string[];
}

/**
 * Makes `r` the current release of its targets. Targets without a current release always switch (a new platform,
 * architecture or channel). Targets that already have a different current release switch only when `supersede` is
 * true; the replaced releases that end up current nowhere are marked superseded (superseded_by = r). Call INSIDE the
 * caller's transaction, after every check has passed, so the switch is all-or-nothing with the rest of the step.
 */
export function switchCurrent(db: Db, r: ReleaseLite, opts: { supersede: boolean; at: number; by: string }): SwitchResult {
  const result: SwitchResult = { switched: [], kept: [], superseded: [] };
  const touched = new Set<string>();
  for (const t of targetsOf(db, r)) {
    const cur = currentOf(db, t);
    if (cur?.release_id === r.id) continue;
    if (cur && !opts.supersede && isLive(db, cur.release_id)) {
      result.kept.push({ target: t, current: cur.release_id });
      continue;
    }
    db.prepare(
      `INSERT INTO pub_current (product_id, edition_key, platform, arch, channel, release_id, selected_at, selected_by) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (product_id, edition_key, platform, arch, channel) DO UPDATE SET release_id = excluded.release_id, selected_at = excluded.selected_at, selected_by = excluded.selected_by`,
    ).run(t.productId, t.editionKey, t.platform, t.arch, t.channel, r.id, opts.at, opts.by);
    result.switched.push({ target: t, previous: cur?.release_id ?? null });
    if (cur) touched.add(cur.release_id);
  }
  if (opts.supersede) {
    for (const old of touched) {
      const stillCurrent = (db.prepare("SELECT count(*) AS n FROM pub_current WHERE release_id = ?").get(old) as { n: number }).n;
      const row = db.prepare("SELECT status FROM pub_releases WHERE id = ?").get(old) as { status: string } | undefined;
      if (stillCurrent === 0 && row?.status === "published") {
        db.prepare("UPDATE pub_releases SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(r.id, opts.at, old);
        result.superseded.push(old);
      }
    }
  }
  // A superseded release that becomes current again (restore) is published again.
  db.prepare("UPDATE pub_releases SET status = 'published', superseded_by = NULL, updated_at = ? WHERE id = ? AND status = 'superseded'").run(opts.at, r.id);
  return result;
}

/** A release that can actually serve customers on a target it is current for. */
function isLive(db: Db, releaseId: string): boolean {
  const r = db.prepare("SELECT status, availability FROM pub_releases WHERE id = ?").get(releaseId) as { status: string; availability: string } | undefined;
  return !!r && r.status === "published" && r.availability === "available";
}

/** Removes a release from every target it is current on (revocation). Returns the targets now without a current release. */
export function clearCurrent(db: Db, releaseId: string): Target[] {
  const rows = currentTargetsOfRelease(db, releaseId);
  db.prepare("DELETE FROM pub_current WHERE release_id = ?").run(releaseId);
  return rows.map((c) => ({ productId: c.product_id, editionKey: c.edition_key, platform: c.platform, arch: c.arch, channel: c.channel }));
}

/** Is this artifact on a target where its release is current? (Customer delivery requires it.) */
export function artifactIsCurrent(db: Db, a: { release_id: string; platform: string; architectures: string }, r: ReleaseLite): boolean {
  const archs = JSON.parse(a.architectures) as string[];
  return (archs.length ? archs : ["any"]).some((arch) => currentOf(db, { productId: r.product_id, editionKey: r.edition_id ?? "", platform: a.platform, arch, channel: r.channel })?.release_id === r.id);
}

/**
 * Lifecycle label for people (Release Manager): one word for the review dimension, plus availability and currency.
 * Draft-time stages come from the files: uploading → validation required → ready for review.
 */
export function lifecycleOf(
  r: { status: string; availability: string },
  files: { status: string }[],
  currentTargets: number,
): { review: string; availability: string; currency: "current" | "superseded" | "not-current"; label: string } {
  const live = files.filter((f) => f.status !== "removed");
  let review = r.status;
  if (r.status === "draft") {
    if (live.some((f) => ["awaiting-upload", "uploading"].includes(f.status))) review = "uploading";
    else if (live.some((f) => f.status === "rejected") && !live.some((f) => f.status === "verified")) review = "validation-required";
    else if (live.some((f) => f.status === "verified")) review = "ready-for-review";
    else review = "draft";
  }
  const currency = currentTargets > 0 ? "current" : r.status === "superseded" ? "superseded" : "not-current";
  const label =
    r.availability !== "available" ? r.availability
    : r.status === "withdrawn" ? "withdrawn"
    : currency === "current" && r.status === "published" ? "current"
    : review;
  return { review, availability: r.availability, currency, label };
}
