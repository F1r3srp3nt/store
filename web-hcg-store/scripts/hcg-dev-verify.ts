/**
 * Guided verification of HCG Store's sign-in against the REAL HCG Connect, with the development
 * client. Run on the machine where `npm run hcg:dev` is running: `npm run hcg:dev:verify`
 * (`-- --auto-only` runs only the automatic checks).
 *
 * Evidence comes only from HCG's public endpoints, from the local server's HTTP answers, and from the
 * server's database: the `auth_events` trail and token-free session columns (whether a token column is
 * empty, never its value). Nothing here reads, prints or stores a token, code or cookie.
 *
 * A report is written to `.hcg-dev/evidence-<time>.md`. Steps you skip are reported as "not run",
 * never as passed.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { loadEnvFile } from "./hcg-dev-env";

type Outcome = "pass" | "fail" | "not run" | "inconclusive";
interface Check {
  group: "Configuration (HCG)" | "Local server" | "Sign-in (you)";
  item: string;
  outcome: Outcome;
  evidence: string;
}

const root = resolve(import.meta.dirname, "..");
const env = loadEnvFile(join(root, "server/dev/hcg-connect.development.env"));
const ORIGIN = env.HCG_STORE_PUBLIC_ORIGIN!;
const ISSUER = env.HCG_CONNECT_ISSUER!;
const CLIENT = env.HCG_CONNECT_CLIENT_ID!;
const REDIRECT = env.HCG_CONNECT_REDIRECT_URI!;
const ECOSYSTEM = env.HCG_ECOSYSTEM_API_URL!;
const DB_FILE = join(root, env.HCG_STORE_DATA_DIR!, "hcg-store.sqlite");
const autoOnly = process.argv.includes("--auto-only");

const checks: Check[] = [];
const add = (group: Check["group"], item: string, outcome: Outcome, evidence: string) => {
  checks.push({ group, item, outcome, evidence });
  const mark = outcome === "pass" ? "✔" : outcome === "fail" ? "✖" : "–";
  console.log(`${mark} ${item}: ${outcome}${evidence ? ` (${evidence})` : ""}`);
};
const b64url = (b: Buffer) => b.toString("base64url");
const pkcePair = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
async function get(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
  } catch (e) {
    return { status: 0, headers: new Headers(), text: async () => String(e), json: async () => ({}) } as unknown as Response;
  }
}

// ----------------------------------------------------------------- configuration (real HCG)
async function configurationChecks() {
  console.log("\nConfiguration checks against the real HCG Connect");
  const d = await get(`${ISSUER}/.well-known/openid-configuration`);
  if (d.status === 0) {
    for (const i of ["Discovery document matches the handoff", "Signing keys (JWKS)", "Client is registered (exact callback accepted)", "Unregistered callback refused", "Ecosystem /me requires a token"]) {
      add("Configuration (HCG)", i, "not run", "HCG is not reachable from this machine");
    }
    return;
  }
  if (d.status !== 200) {
    add("Configuration (HCG)", "Discovery document", "fail", `HTTP ${d.status}`);
  } else {
    const doc = (await d.json()) as Record<string, unknown>;
    const has = (k: string, v: string) => Array.isArray(doc[k]) && (doc[k] as unknown[]).includes(v);
    const problems = [
      doc.issuer !== ISSUER && "issuer",
      doc.authorization_endpoint !== env.HCG_CONNECT_AUTHORIZATION_ENDPOINT && "authorization_endpoint",
      doc.token_endpoint !== env.HCG_CONNECT_TOKEN_ENDPOINT && "token_endpoint",
      doc.jwks_uri !== env.HCG_CONNECT_JWKS_URI && "jwks_uri",
      !has("code_challenge_methods_supported", "S256") && "PKCE S256",
      !has("grant_types_supported", "authorization_code") && "authorization_code",
      !has("grant_types_supported", "refresh_token") && "refresh_token",
      Array.isArray(doc.token_endpoint_auth_methods_supported) && !has("token_endpoint_auth_methods_supported", "none") && "public clients",
    ].filter(Boolean);
    add("Configuration (HCG)", "Discovery document matches the handoff", problems.length ? "fail" : "pass", problems.length ? `differs: ${problems.join(", ")}` : `issuer ${ISSUER}`);
    add(
      "Configuration (HCG)",
      "Revocation / end-session endpoint",
      "pass",
      doc.revocation_endpoint || doc.end_session_endpoint ? "ADVERTISED: review the logout model" : "not advertised (Store logout is local only, as documented)",
    );
  }
  const j = await get(env.HCG_CONNECT_JWKS_URI!);
  const keys = j.status === 200 ? (((await j.json()) as { keys?: { alg?: string }[] }).keys ?? []) : [];
  add("Configuration (HCG)", "Signing keys (JWKS)", keys.length ? "pass" : "fail", keys.length ? `${keys.length} key(s): ${keys.map((k) => k.alg ?? "?").join(", ")}` : `HTTP ${j.status}`);

  const authorize = (redirectUri: string) => {
    const { challenge } = pkcePair();
    const u = new URL(env.HCG_CONNECT_AUTHORIZATION_ENDPOINT!);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: redirectUri,
      scope: env.HCG_CONNECT_SCOPES ?? "openid email profile",
      state: b64url(randomBytes(24)),
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return get(u.toString());
  };
  const ok = await authorize(REDIRECT);
  const okBody = ok.status >= 400 ? await ok.text() : "";
  const okLoc = ok.headers.get("location") ?? "";
  if (/oauth_client_not_found/.test(okBody)) add("Configuration (HCG)", "Client is registered", "fail", "HCG answered oauth_client_not_found");
  else if ((ok.status === 302 || ok.status === 303) && !/error=/.test(okLoc)) add("Configuration (HCG)", "Client is registered (exact callback accepted)", "pass", `HTTP ${ok.status} to ${new URL(okLoc, ISSUER).host}`);
  else add("Configuration (HCG)", "Client is registered", "inconclusive", `HTTP ${ok.status}${okLoc ? ` → ${okLoc.slice(0, 80)}` : ""}`);

  const wrong = await authorize(`${REDIRECT}-not-registered`);
  const wrongLoc = wrong.headers.get("location") ?? "";
  if (wrong.status >= 400 || /error=/.test(wrongLoc)) add("Configuration (HCG)", "Unregistered callback refused", "pass", `HTTP ${wrong.status}`);
  else add("Configuration (HCG)", "Unregistered callback refused", "fail", `HCG did not refuse it at authorize (HTTP ${wrong.status}); report this to the main site`);

  const me = await get(`${ECOSYSTEM}/me`);
  add("Configuration (HCG)", "Ecosystem /me requires a token", me.status === 401 ? "pass" : "fail", `HTTP ${me.status}`);
}

// ----------------------------------------------------------------- local server (no sign-in)
async function localChecks() {
  console.log(`\nLocal server checks (${ORIGIN})`);
  const h = await get(`${ORIGIN}/api/v1/health`);
  if (h.status !== 200) {
    add("Local server", "Server running", "fail", `HTTP ${h.status}: start it with npm run hcg:dev`);
    return false;
  }
  const health = (await h.json()) as Record<string, string>;
  add(
    "Local server",
    "Running with HCG Connect; purchases and downloads off",
    health.hcgConnect === "configured" && health.payments === "disabled" && health.protectedDownloads === "disabled" ? "pass" : "fail",
    `hcgConnect=${health.hcgConnect}, payments=${health.payments}, protectedDownloads=${health.protectedDownloads}`,
  );

  const starts = [await get(`${ORIGIN}/auth/login?return_to=/account`), await get(`${ORIGIN}/auth/login?return_to=/account`)];
  const urls = starts.map((r) => (r.status === 302 ? new URL(r.headers.get("location") ?? "") : null));
  const p = urls.map((u) => u?.searchParams);
  const problems = [
    !urls[0] && "no redirect",
    urls[0] && `${urls[0].origin}${urls[0].pathname}` !== env.HCG_CONNECT_AUTHORIZATION_ENDPOINT && "wrong authorize endpoint",
    p[0]?.get("client_id") !== CLIENT && "client_id",
    p[0]?.get("redirect_uri") !== REDIRECT && "redirect_uri",
    p[0]?.get("response_type") !== "code" && "response_type",
    p[0]?.get("code_challenge_method") !== "S256" && "PKCE method",
    !/^[A-Za-z0-9_-]{43}$/.test(p[0]?.get("code_challenge") ?? "") && "code_challenge",
    (p[0]?.get("state") ?? "").length < 32 && "state length",
    !p[0]?.get("nonce") && "nonce",
    p[0]?.get("state") === p[1]?.get("state") && "state reused",
    p[0]?.get("code_challenge") === p[1]?.get("code_challenge") && "challenge reused",
  ].filter(Boolean);
  add("Local server", "1. Authorization starts with PKCE S256, state and nonce", problems.length ? "fail" : "pass", problems.length ? problems.join(", ") : `fresh state and challenge per attempt; callback ${REDIRECT}`);

  const forged = await get(`${ORIGIN}/auth/callback?code=forged&state=${b64url(randomBytes(24))}`);
  const noState = await get(`${ORIGIN}/auth/callback?code=forged`);
  add("Local server", "6. Forged and stateless callbacks rejected", forged.status === 400 && noState.status === 400 ? "pass" : "fail", `HTTP ${forged.status}, ${noState.status}`);
  // Replay: a real sign-in attempt, its callback sent with an invalid code (HCG's token endpoint refuses
  // it), then the same callback again. The state must already be used up.
  const attempt = await get(`${ORIGIN}/auth/login?return_to=/account`);
  const state = attempt.status === 302 ? new URL(attempt.headers.get("location") ?? "").searchParams.get("state") : null;
  if (state) {
    const cb = `${ORIGIN}/auth/callback?code=${b64url(randomBytes(16))}&state=${encodeURIComponent(state)}`;
    const first = await get(cb);
    const again = await get(cb);
    const reasons = existsSync(DB_FILE)
      ? (new DatabaseSync(DB_FILE).prepare("SELECT detail FROM auth_events WHERE type = 'login_rejected' ORDER BY id DESC LIMIT 2").all() as unknown as { detail: string }[])
          .reverse()
          .map((r) => JSON.parse(r.detail) as { reason: string; check?: string })
      : [];
    const ok = first.status === 400 && again.status === 400 && reasons[0]?.reason === "exchange_or_verification_failed" && reasons[1]?.reason === "state_unknown_or_already_used";
    add("Local server", "6. Replayed callback rejected (state is single-use)", ok ? "pass" : "fail", `invalid code: HTTP ${first.status} (${reasons[0]?.check ?? "?"}); replay: HTTP ${again.status} (${reasons[1]?.reason ?? "?"})`);
  } else add("Local server", "6. Replayed callback rejected (state is single-use)", "fail", "could not start a sign-in attempt");

  const lib = await get(`${ORIGIN}/api/v1/library`);
  add("Local server", "6. Protected request without a session rejected", lib.status === 401 ? "pass" : "fail", `/api/v1/library HTTP ${lib.status}`);
  const csrf = await get(`${ORIGIN}/auth/logout`, { method: "POST", headers: { origin: "https://attacker.example" } });
  add("Local server", "Logout refuses other origins", csrf.status === 403 ? "pass" : "fail", `HTTP ${csrf.status}`);
  return true;
}

// ----------------------------------------------------------------- guided sign-in (real account)
interface Ev {
  id: number;
  at: number;
  type: string;
  session_ref: string | null;
  sub: string | null;
  detail: string | null;
}
const detail = (e: Ev | undefined) => (e?.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : {});

async function guided(t0: number) {
  if (!existsSync(DB_FILE)) {
    add("Sign-in (you)", "Server database", "fail", `not found at ${DB_FILE}`);
    return;
  }
  const db = new DatabaseSync(DB_FILE);
  const eventsSince = (at: number) => db.prepare("SELECT id, at, type, session_ref, sub, detail FROM auth_events WHERE at >= ? ORDER BY id").all(at) as unknown as Ev[];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const step = async (text: string) => (await rl.question(`\n${text}\nPress Enter when done (or type "skip"): `)).trim().toLowerCase() !== "skip";

  // 2 + 3: sign-in
  if (!(await step(`STEP A. In your browser open ${ORIGIN}/account, choose "Sign in with HCG Connect" and sign in with your HCG account.`))) {
    for (const i of ["2. Callback at the exact registered URI", "3. Code exchange and account matches /me", "4. Session restored after restart", "4. Token refresh with rotation", "5. Logout clears session and tokens"]) add("Sign-in (you)", i, "not run", "skipped");
    rl.close();
    return;
  }
  const ev = eventsSince(t0);
  const ok = [...ev].reverse().find((e) => e.type === "login_succeeded");
  const rejected = ev.filter((e) => e.type === "login_rejected").map((e) => detail(e).reason);
  if (!ok) {
    add("Sign-in (you)", "2. Callback at the exact registered URI", "fail", rejected.length ? `rejected: ${rejected.join(", ")}` : "no completed sign-in recorded");
    add("Sign-in (you)", "3. Code exchange and account matches /me", "not run", "sign-in did not complete");
    rl.close();
    return;
  }
  const d = detail(ok);
  const sessionRef = ok.session_ref!;
  add("Sign-in (you)", "2. Callback at the exact registered URI", d.callback === REDIRECT ? "pass" : "fail", `${d.callback}`);
  add(
    "Sign-in (you)",
    "3. Code exchange and account matches /me",
    d.idTokenVerified && d.accessTokenVerified && d.accountWithMe === "matched" ? "pass" : "fail",
    `ID and access tokens verified; /me: ${d.accountWithMe}; account ${String(ok.sub).slice(0, 8)}…`,
  );
  const loginAt = ok.at;

  // 4a: restore after restart
  if (await step("STEP B. Restart: stop the server (Ctrl-C in its terminal), start it again with `npm run hcg:dev`, then reload the Account page. You should still be signed in.")) {
    const restart = [...eventsSince(loginAt)].reverse().find((e) => e.type === "server_started");
    const row = db.prepare("SELECT last_seen_at, ended_at FROM sessions WHERE substr(id_hash, 1, 12) = ?").get(sessionRef) as { last_seen_at: number; ended_at: number | null } | undefined;
    const restored = !!restart && !!row && row.ended_at === null && row.last_seen_at > restart.at;
    add("Sign-in (you)", "4. Session restored after restart", restored ? "pass" : "fail", restart ? `server restarted ${new Date(restart.at).toISOString()}; session ${restored ? "used afterwards" : "not used afterwards"}` : "no restart recorded");
  } else add("Sign-in (you)", "4. Session restored after restart", "not run", "skipped");

  // 4b: refresh
  if (await step("STEP C. Refresh: wait at least 30 seconds, then reload the Account page.")) {
    const refreshed = eventsSince(loginAt).filter((e) => e.session_ref === sessionRef && e.type === "session_refreshed");
    const rotated = refreshed.some((e) => detail(e).refreshTokenRotated === true);
    const failed = eventsSince(loginAt).filter((e) => e.session_ref === sessionRef && e.type === "session_refresh_failed").map((e) => `${detail(e).status}: ${detail(e).reason}`);
    add("Sign-in (you)", "4. Token refresh with rotation", rotated ? "pass" : "fail", rotated ? `${refreshed.length} refresh(es), refresh token rotated` : failed.length ? failed.join("; ") : "no refresh recorded");
  } else add("Sign-in (you)", "4. Token refresh with rotation", "not run", "skipped");

  // 5: logout
  if (await step("STEP D. Logout: on the Account page choose \"Sign out\".")) {
    const row = db.prepare("SELECT ended_reason, refresh_token IS NULL AS rt_gone, access_token IS NULL AS at_gone FROM sessions WHERE substr(id_hash, 1, 12) = ?").get(sessionRef) as
      | { ended_reason: string | null; rt_gone: number; at_gone: number }
      | undefined;
    const done = !!row && row.ended_reason === "logout" && row.rt_gone === 1 && row.at_gone === 1;
    add("Sign-in (you)", "5. Logout clears session and tokens", done ? "pass" : "fail", row ? `ended: ${row.ended_reason ?? "no"}; stored tokens deleted: ${row.rt_gone && row.at_gone ? "yes" : "no"}. HCG Connect itself is not signed out (no end-session endpoint).` : "session not found");
  } else add("Sign-in (you)", "5. Logout clears session and tokens", "not run", "skipped");
  rl.close();
}

// ----------------------------------------------------------------- report
function report(t0: number) {
  const outDir = join(root, ".hcg-dev");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `evidence-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.md`);
  const rows = checks.map((c) => `| ${c.group} | ${c.item} | **${c.outcome}** | ${c.evidence.replace(/\|/g, "/")} |`).join("\n");
  const signInPassed = checks.filter((c) => c.group === "Sign-in (you)").every((c) => c.outcome === "pass") && checks.some((c) => c.group === "Sign-in (you)");
  writeFileSync(
    file,
    `# HCG Store × HCG Connect development client: evidence\n\nRun ${new Date(t0).toISOString()} on ${ORIGIN}. Client ${CLIENT} (development), callback ${REDIRECT}.\nNo tokens, codes or cookies are included.\n\n| Group | Check | Result | Evidence |\n| --- | --- | --- | --- |\n${rows}\n\n${
      signInPassed ? "All sign-in checks passed with a real HCG account." : "The real sign-in flow has NOT fully passed; do not mark the client verified."
    }\n`,
    { mode: 0o600 },
  );
  console.log(`\nReport: ${file}`);
}

const t0 = Date.now();
await configurationChecks();
const serverUp = await localChecks();
if (!autoOnly && serverUp) await guided(t0);
report(t0);
process.exit(checks.some((c) => c.outcome === "fail") ? 1 : 0);
