/**
 * Operator command for Store profiles (profiles.ts). Runs on the server (on Fly.io through `fly ssh console`), never
 * over HTTP. Text values are passed base64-encoded so no shell quoting can alter them.
 *
 *   node server-dist/store-profile.mjs set --session-ref <12 hex> --display-name-b64 <b64> --designation-b64 <b64>
 *        --authorised-by-b64 <b64> --performed-by-b64 <b64>
 *   node server-dist/store-profile.mjs show --session-ref <12 hex>
 *
 * The account is identified by a sign-in HCG Store verified and matched with HCG's /me (its session reference from
 * the sign-in evidence), never by an e-mail address or a name. Output never contains the full account ID.
 */
import { openDatabase } from "./db";
import { getProfile, ProfileError, setProfile, subjectOfVerifiedSession } from "./profiles";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const b64 = (name: string) => {
  const v = arg(name);
  return v === undefined ? null : Buffer.from(v, "base64").toString("utf8");
};

const db = openDatabase(process.env.HCG_STORE_DATA_DIR ?? "data");
try {
  const sub = subjectOfVerifiedSession(db, arg("--session-ref") ?? "");
  const accountRef = sub.slice(0, 8);
  if (process.argv[2] === "set") {
    const r = setProfile(db, {
      sub,
      displayName: b64("--display-name-b64"),
      designation: b64("--designation-b64"),
      authorisedBy: b64("--authorised-by-b64") ?? "",
      performedBy: b64("--performed-by-b64") ?? "",
      now: Date.now(),
    });
    process.stdout.write(JSON.stringify({ accountRef, changed: r.changed, profile: r.profile }) + "\n");
  } else if (process.argv[2] === "show") {
    const events = db
      .prepare("SELECT at, action, after_json, authorised_by, performed_by FROM store_profile_events WHERE sub = ? ORDER BY id")
      .all(sub);
    process.stdout.write(JSON.stringify({ accountRef, profile: getProfile(db, sub), events }) + "\n");
  } else {
    throw new ProfileError("Use: set | show");
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e instanceof ProfileError ? e.message : "failed" }) + "\n");
  process.exitCode = 1;
} finally {
  db.close();
}
