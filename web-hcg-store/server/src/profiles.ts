/**
 * Store profiles: how HCG Store presents an existing HCG account (a display name and a designation such as
 * "Founder / Original User"). PRESENTATION ONLY. A profile grants nothing: no route, permission check, entitlement
 * or approval rule reads it. HCG (central ERP) stays the only authority for permissions; see publishing.ts.
 *
 * - Keyed to the immutable HCG subject (`sub`) of an account whose sign-in HCG Store verified (ID and access token
 *   checked against HCG's keys, and the account matched HCG's /me). Never to an e-mail address or a name.
 * - Set only by an operator command on the server (store-profile-cli.ts). There is no HTTP route that writes it, so
 *   no browser, form field or token claim can change it.
 * - Every change is in `store_profile_events` (append-only: database triggers refuse update and delete) with who
 *   authorised it and who performed it. Setting the same values again changes nothing and records nothing.
 * - Registration dates and history are never touched: the profile has its own timestamps only.
 */
import type { Db } from "./db";

export interface StoreProfile {
  displayName: string | null;
  designation: string | null;
}

export class ProfileError extends Error {}

const clean = (v: string | null, max: number, field: string): string | null => {
  if (v === null) return null;
  const t = v.normalize("NFC").trim();
  if (!t) return null;
  if (t.length > max) throw new ProfileError(`${field} is longer than ${max} characters.`);
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(t)) throw new ProfileError(`${field} contains control or direction characters.`);
  return t;
};

export function getProfile(db: Db, sub: string): StoreProfile | null {
  const r = db.prepare("SELECT display_name, designation FROM store_profiles WHERE sub = ?").get(sub) as
    | { display_name: string | null; designation: string | null }
    | undefined;
  return r ? { displayName: r.display_name, designation: r.designation } : null;
}

/**
 * The subject of a session HCG Store verified at sign-in AND matched with HCG's /me. `sessionRef` is the 12-hex
 * reference shown in the sign-in evidence (never the cookie). Refuses unknown, ambiguous or unconfirmed sessions.
 */
export function subjectOfVerifiedSession(db: Db, sessionRef: string): string {
  if (!/^[0-9a-f]{12}$/.test(sessionRef)) throw new ProfileError("The session reference is 12 lowercase hex characters.");
  const rows = db
    .prepare("SELECT DISTINCT sub FROM sessions WHERE substr(id_hash, 1, 12) = ? AND account_confirmed_at IS NOT NULL")
    .all(sessionRef) as { sub: string }[];
  if (rows.length !== 1) throw new ProfileError("No single sign-in that HCG Store verified and matched with HCG's /me has that reference.");
  return rows[0]!.sub;
}

export function setProfile(
  db: Db,
  input: { sub: string; displayName: string | null; designation: string | null; authorisedBy: string; performedBy: string; now: number },
): { changed: boolean; profile: StoreProfile } {
  const displayName = clean(input.displayName, 80, "Display name");
  const designation = clean(input.designation, 60, "Designation");
  const authorisedBy = clean(input.authorisedBy, 300, "Authorised by");
  const performedBy = clean(input.performedBy, 300, "Performed by");
  if (!authorisedBy || !performedBy) throw new ProfileError("Record who authorised and who performed the change.");
  const before = getProfile(db, input.sub);
  if (before && before.displayName === displayName && before.designation === designation) return { changed: false, profile: before };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO store_profiles (sub, display_name, designation, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (sub) DO UPDATE SET display_name = excluded.display_name, designation = excluded.designation, updated_at = excluded.updated_at`,
    ).run(input.sub, displayName, designation, input.now, input.now);
    db.prepare(
      `INSERT INTO store_profile_events (at, sub, action, before_json, after_json, authorised_by, performed_by) VALUES (?, ?, 'profile.set', ?, ?, ?, ?)`,
    ).run(input.now, input.sub, JSON.stringify(before), JSON.stringify({ displayName, designation }), authorisedBy, performedBy);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { changed: true, profile: { displayName, designation } };
}
