/**
 * Operator command for founder-operated release exceptions (release-exceptions.ts). Runs on the server, never over
 * HTTP. The account is named by the 12-hex reference of a sign-in HCG Store verified and matched with HCG's /me (from
 * the sign-in evidence); the account ID itself is never printed. Text is passed base64-encoded.
 *
 *   node server-dist/release-exception.mjs grant --release rel-… --session-ref <12 hex> [--digest <64 hex>]
 *        --reason-b64 <b64> --authorised-by-b64 <b64> --performed-by-b64 <b64>
 *   node server-dist/release-exception.mjs revoke --id rx-… --reason-b64 … --authorised-by-b64 … --performed-by-b64 …
 *   node server-dist/release-exception.mjs list --release rel-…
 *
 * An exception is not a permission: the person still needs HCG's store.publish, store.release.approve and
 * store.release.publish for each separate step, and it applies only while the release's files are unchanged.
 */
import { parseStoreConfig } from "./config";
import { openDatabase } from "./db";
import { ProfileError, subjectOfVerifiedSession } from "./profiles";
import { artifactSetDigest, exceptionsFor, grantFounderException, ReleaseExceptionError, revokeException } from "./release-exceptions";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : v;
};
const b64 = (name: string) => Buffer.from(arg(name) ?? "", "base64").toString("utf8");
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

const cfg = parseStoreConfig(process.env);
const db = openDatabase(cfg.dataDir);
const now = Date.now();
try {
  const who = { authorisedBy: b64("--authorised-by-b64"), performedBy: b64("--performed-by-b64") };
  const cmd = process.argv[2];
  const show = (x: ReturnType<typeof grantFounderException>) => ({ ...x, createdAt: iso(x.createdAt), revokedAt: iso(x.revokedAt) });
  if (cmd === "grant") {
    const releaseId = arg("--release") ?? "";
    const subject = subjectOfVerifiedSession(db, arg("--session-ref") ?? "");
    const x = grantFounderException(db, { releaseId, subject, reason: b64("--reason-b64"), expectDigest: arg("--digest") ?? null, ...who }, now);
    process.stdout.write(JSON.stringify({ granted: show(x), note: "Bound to these exact files. Not an independent review. Each step still needs its own HCG permission." }) + "\n");
  } else if (cmd === "revoke") {
    process.stdout.write(JSON.stringify({ revoked: show(revokeException(db, arg("--id") ?? "", { reason: b64("--reason-b64"), ...who }, now)) }) + "\n");
  } else if (cmd === "list") {
    const releaseId = arg("--release") ?? "";
    process.stdout.write(JSON.stringify({ releaseId, filesDigest: artifactSetDigest(db, releaseId), exceptions: exceptionsFor(db, releaseId).map((x) => ({ ...x, createdAt: iso(x.createdAt), revokedAt: iso(x.revokedAt) })) }) + "\n");
  } else {
    throw new ReleaseExceptionError("Use: grant | revoke | list");
  }
} catch (e) {
  const known = e instanceof ReleaseExceptionError || e instanceof ProfileError;
  process.stdout.write(JSON.stringify({ error: known ? e.message : (e as Error).message }) + "\n");
  process.exitCode = 1;
} finally {
  db.close();
}
