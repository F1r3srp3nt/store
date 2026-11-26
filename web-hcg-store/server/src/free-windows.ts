/**
 * Free testing windows: a time-limited, independently controlled free period for one product edition (optionally one
 * release). While a window is open, the edition's PUBLISHED, PUBLIC, FREE releases are delivered to every signed-in
 * HCG account. Nothing else changes: no price or offer is created or altered, no payment details are asked for, no
 * checkout runs, and nothing is charged when the window ends. Then the free files simply stop being delivered.
 *
 * Opened, extended and terminated only by the operator path (store-free-window CLI, run through the deploy workflow),
 * recorded with who authorised and who performed each change in `free_window_events` (append-only). No HTTP route writes
 * a window.
 */
import { randomBytes } from "node:crypto";
import { transaction, type Db } from "./db";

export const MAX_WINDOW_DAYS = 366;
const DAY = 24 * 3600 * 1000;

export interface FreeWindow {
  id: string;
  productId: string;
  editionId: string | null;
  releaseId: string | null;
  /** Null while a window anchored to publication waits for its release to be published. */
  startsAt: number | null;
  endsAt: number | null;
  anchor: "fixed" | "publication";
  /** For a publication-anchored window: how long it lasts from publication. */
  durationMs: number | null;
  terminatedAt: number | null;
  terminatedReason: string | null;
  state: "awaiting-publication" | "scheduled" | "open" | "ended" | "terminated";
}

export class FreeWindowError extends Error {}

type Row = {
  id: string; product_id: string; edition_id: string | null; release_id: string | null; starts_at: number | null; ends_at: number | null;
  anchor: "fixed" | "publication"; duration_ms: number | null; terminated_at: number | null; terminated_reason: string | null;
};

const view = (r: Row, now: number): FreeWindow => ({
  id: r.id,
  productId: r.product_id,
  editionId: r.edition_id,
  releaseId: r.release_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  anchor: r.anchor,
  durationMs: r.duration_ms,
  terminatedAt: r.terminated_at,
  terminatedReason: r.terminated_reason,
  state: r.terminated_at !== null ? "terminated"
    : r.starts_at === null || r.ends_at === null ? "awaiting-publication"
    : now < r.starts_at ? "scheduled" : now < r.ends_at ? "open" : "ended",
});

export function listWindows(db: Db, now: number, productId?: string): FreeWindow[] {
  const rows = (productId
    ? db.prepare("SELECT * FROM free_windows WHERE product_id = ? ORDER BY created_at").all(productId)
    : db.prepare("SELECT * FROM free_windows ORDER BY created_at").all()) as Row[];
  return rows.map((r) => view(r, now));
}

/** The window open right now for this edition (and release, when the window names one), if any. */
export function openWindowFor(db: Db, productId: string, editionId: string | null, now: number): FreeWindow | null {
  const r = db
    .prepare("SELECT * FROM free_windows WHERE product_id = ? AND edition_id IS ? AND terminated_at IS NULL AND starts_at IS NOT NULL AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1")
    .get(productId, editionId, now, now) as Row | undefined;
  return r ? view(r, now) : null;
}

function event(db: Db, windowId: string, action: string, detail: object, who: { authorisedBy: string; performedBy: string }, now: number) {
  if (!who.authorisedBy.trim() || !who.performedBy.trim()) throw new FreeWindowError("Record who authorised and who performed the change.");
  db.prepare("INSERT INTO free_window_events (at, window_id, action, detail, authorised_by, performed_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, windowId, action, JSON.stringify(detail), who.authorisedBy.trim().slice(0, 200), who.performedBy.trim().slice(0, 200));
}

export type WindowPeriod =
  | { anchor: "fixed"; startsAt: number; endsAt: number }
  /**
   * Starts when the named release is published and lasts `durationMs`. If the release is already published
   * (`publishedAt`), it starts at that publication time.
   */
  | { anchor: "publication"; durationMs: number; publishedAt: number | null };

export function openWindow(
  db: Db,
  w: { productId: string; editionId: string | null; releaseId: string | null; period: WindowPeriod; authorisedBy: string; performedBy: string },
  now: number,
): FreeWindow {
  let startsAt: number | null;
  let endsAt: number | null;
  let durationMs: number | null = null;
  if (w.period.anchor === "fixed") {
    ({ startsAt, endsAt } = w.period);
  } else {
    if (!w.releaseId) throw new FreeWindowError("A window that starts at publication names the release.");
    durationMs = w.period.durationMs;
    if (!(durationMs > 0)) throw new FreeWindowError("The window must last a positive time.");
    if (durationMs > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days; extend it later if needed.`);
    startsAt = w.period.publishedAt;
    endsAt = startsAt === null ? null : startsAt + durationMs;
  }
  if (startsAt !== null && endsAt !== null) {
    if (!(endsAt > startsAt)) throw new FreeWindowError("The window must end after it starts.");
    if (endsAt <= now) throw new FreeWindowError("The window must end in the future.");
    if (endsAt - startsAt > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days; extend it later if needed.`);
  }
  // A window waiting for publication clashes with any window not yet over; a dated one with those overlapping it
  // (and with any window still waiting for publication, whose dates are not known yet).
  const clash = (startsAt === null
    ? db.prepare("SELECT id FROM free_windows WHERE product_id = ? AND edition_id IS ? AND terminated_at IS NULL AND (ends_at IS NULL OR ends_at > ?)").get(w.productId, w.editionId, now)
    : db.prepare("SELECT id FROM free_windows WHERE product_id = ? AND edition_id IS ? AND terminated_at IS NULL AND (ends_at IS NULL OR (ends_at > ? AND starts_at < ?))").get(w.productId, w.editionId, startsAt, endsAt)) as { id: string } | undefined;
  if (clash) throw new FreeWindowError(`Window ${clash.id} already covers part of this period; extend or terminate it instead.`);
  const id = `fw-${randomBytes(6).toString("hex")}`;
  transaction(db, () => {
    db.prepare("INSERT INTO free_windows (id, product_id, edition_id, release_id, starts_at, ends_at, anchor, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, w.productId, w.editionId, w.releaseId, startsAt, endsAt, w.period.anchor, durationMs, now);
    event(db, id, startsAt === null ? "window.prepared" : "window.opened", { productId: w.productId, editionId: w.editionId, releaseId: w.releaseId, anchor: w.period.anchor, startsAt, endsAt, durationMs }, w, now);
  });
  return view(db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row, now);
}

/**
 * Extends a window: a later end for a window that has started, or a longer duration for one still waiting for its
 * release to be published.
 */
export function extendWindow(db: Db, id: string, change: { endsAt: number } | { durationMs: number }, who: { authorisedBy: string; performedBy: string }, now: number): FreeWindow {
  const r = db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new FreeWindowError("No such window.");
  const v = view(r, now);
  if (v.state === "terminated" || v.state === "ended") throw new FreeWindowError(`The window has ${v.state === "terminated" ? "been terminated" : "ended"}; open a new one instead.`);
  if (r.starts_at === null) {
    if (!("durationMs" in change)) throw new FreeWindowError("This window has not started (its release is not published yet); give a longer duration in days.");
    if (!(change.durationMs > (r.duration_ms ?? 0))) throw new FreeWindowError("An extension must be longer than the current duration.");
    if (change.durationMs > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days.`);
    transaction(db, () => {
      db.prepare("UPDATE free_windows SET duration_ms = ? WHERE id = ?").run(change.durationMs, id);
      event(db, id, "window.extended", { previousDurationMs: r.duration_ms, durationMs: change.durationMs }, who, now);
    });
  } else {
    const endsAt = "endsAt" in change ? change.endsAt : r.starts_at + change.durationMs;
    if (!(endsAt > r.ends_at!)) throw new FreeWindowError("An extension must end later than the current end.");
    if (endsAt - r.starts_at > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days.`);
    transaction(db, () => {
      db.prepare("UPDATE free_windows SET ends_at = ? WHERE id = ?").run(endsAt, id);
      event(db, id, "window.extended", { previousEndsAt: r.ends_at, endsAt }, who, now);
    });
  }
  return view(db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row, now);
}

/** Ends free delivery at once (manual termination). Nothing is charged; files already downloaded are unaffected. */
export function terminateWindow(db: Db, id: string, reason: string, who: { authorisedBy: string; performedBy: string }, now: number): FreeWindow {
  const r = db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new FreeWindowError("No such window.");
  if (r.terminated_at !== null) return view(r, now); // idempotent
  if (!reason.trim()) throw new FreeWindowError("Give a reason for terminating the window.");
  transaction(db, () => {
    db.prepare("UPDATE free_windows SET terminated_at = ?, terminated_reason = ? WHERE id = ?").run(now, reason.trim().slice(0, 500), id);
    event(db, id, "window.terminated", { reason: reason.trim().slice(0, 500), wasEndingAt: r.ends_at }, who, now);
  });
  return view(db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row, now);
}
