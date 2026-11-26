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
  startsAt: number;
  endsAt: number;
  terminatedAt: number | null;
  terminatedReason: string | null;
  state: "scheduled" | "open" | "ended" | "terminated";
}

export class FreeWindowError extends Error {}

type Row = { id: string; product_id: string; edition_id: string | null; release_id: string | null; starts_at: number; ends_at: number; terminated_at: number | null; terminated_reason: string | null };

const view = (r: Row, now: number): FreeWindow => ({
  id: r.id,
  productId: r.product_id,
  editionId: r.edition_id,
  releaseId: r.release_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  terminatedAt: r.terminated_at,
  terminatedReason: r.terminated_reason,
  state: r.terminated_at !== null ? "terminated" : now < r.starts_at ? "scheduled" : now < r.ends_at ? "open" : "ended",
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
    .prepare("SELECT * FROM free_windows WHERE product_id = ? AND edition_id IS ? AND terminated_at IS NULL AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1")
    .get(productId, editionId, now, now) as Row | undefined;
  return r ? view(r, now) : null;
}

function event(db: Db, windowId: string, action: string, detail: object, who: { authorisedBy: string; performedBy: string }, now: number) {
  if (!who.authorisedBy.trim() || !who.performedBy.trim()) throw new FreeWindowError("Record who authorised and who performed the change.");
  db.prepare("INSERT INTO free_window_events (at, window_id, action, detail, authorised_by, performed_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, windowId, action, JSON.stringify(detail), who.authorisedBy.trim().slice(0, 200), who.performedBy.trim().slice(0, 200));
}

export function openWindow(
  db: Db,
  w: { productId: string; editionId: string | null; releaseId: string | null; startsAt: number; endsAt: number; authorisedBy: string; performedBy: string },
  now: number,
): FreeWindow {
  if (!(w.endsAt > w.startsAt)) throw new FreeWindowError("The window must end after it starts.");
  if (w.endsAt <= now) throw new FreeWindowError("The window must end in the future.");
  if (w.endsAt - w.startsAt > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days; extend it later if needed.`);
  const clash = db
    .prepare("SELECT id FROM free_windows WHERE product_id = ? AND edition_id IS ? AND terminated_at IS NULL AND ends_at > ? AND starts_at < ?")
    .get(w.productId, w.editionId, w.startsAt, w.endsAt) as { id: string } | undefined;
  if (clash) throw new FreeWindowError(`Window ${clash.id} already covers part of this period; extend or terminate it instead.`);
  const id = `fw-${randomBytes(6).toString("hex")}`;
  transaction(db, () => {
    db.prepare("INSERT INTO free_windows (id, product_id, edition_id, release_id, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, w.productId, w.editionId, w.releaseId, w.startsAt, w.endsAt, now);
    event(db, id, "window.opened", { productId: w.productId, editionId: w.editionId, releaseId: w.releaseId, startsAt: w.startsAt, endsAt: w.endsAt }, w, now);
  });
  return view(db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row, now);
}

export function extendWindow(db: Db, id: string, endsAt: number, who: { authorisedBy: string; performedBy: string }, now: number): FreeWindow {
  const r = db.prepare("SELECT * FROM free_windows WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new FreeWindowError("No such window.");
  const v = view(r, now);
  if (v.state === "terminated" || v.state === "ended") throw new FreeWindowError(`The window has ${v.state === "terminated" ? "been terminated" : "ended"}; open a new one instead.`);
  if (!(endsAt > r.ends_at)) throw new FreeWindowError("An extension must end later than the current end.");
  if (endsAt - r.starts_at > MAX_WINDOW_DAYS * DAY) throw new FreeWindowError(`A window lasts at most ${MAX_WINDOW_DAYS} days.`);
  transaction(db, () => {
    db.prepare("UPDATE free_windows SET ends_at = ? WHERE id = ?").run(endsAt, id);
    event(db, id, "window.extended", { previousEndsAt: r.ends_at, endsAt }, who, now);
  });
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
