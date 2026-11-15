/**
 * HCG Store server configuration. Read from environment variables only (never from VITE_ variables,
 * which end up in the public bundle). Unsafe combinations are refused at start-up.
 *
 * The defaults are deliberately closed: no sign-in, no payments, no protected downloads.
 */
import { randomBytes } from "node:crypto";

export type StoreMode = "test" | "production";

export interface HcgConnectSettings {
  /** Exact issuer, e.g. https://<project>.supabase.co/auth/v1 */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Public client ID issued centrally by HCG. HCG Store never registers clients itself. */
  clientId: string;
  /** Exact redirect URI registered for that client, e.g. https://store.hakmicapitalgroup.com/auth/callback */
  redirectUri: string;
  scopes: string;
}

export interface EcosystemSettings {
  /** Base URL of HCG's ecosystem API, e.g. https://beta.hakmicapitalgroup.com/api/public/ecosystem/v1 */
  baseUrl: string;
}

export interface StoreConfig {
  mode: StoreMode;
  /** Public origin of the Store (scheme + host [+ port]); used for cookies, CSRF checks and links. */
  publicOrigin: string;
  /** Public origin of HCG Repo, allowed to read access state with credentials (CORS). */
  repoOrigins: string[];
  port: number;
  host: string;
  dataDir: string;
  /** Built single-page app to serve (dist/). Empty = API only. */
  staticDir: string;
  catalogueDir: string;
  offersFile: string;
  artifactsFile: string;
  /** Private directory holding protected files. Never inside staticDir. */
  artifactStorageDir: string;
  /** 32-byte key: seals stored tokens and signs short-lived download URLs. */
  secretKey: Buffer;
  hcgConnect: HcgConnectSettings | null;
  ecosystem: EcosystemSettings | null;
  /** "test-ledger" exists only in test mode; "hcg-ecosystem" asks HCG's API. */
  entitlementAuthority: "none" | "test-ledger" | "hcg-ecosystem";
  paymentProvider: "none" | "test";
  testPaymentWebhookSecret: string | null;
  /** Launch switch for protected file delivery. Off unless explicitly enabled. */
  protectedDownloads: boolean;
  /** How old a central session confirmation may be before a protected action re-confirms it. */
  sessionRecheckSeconds: number;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  downloadUrlTtlSeconds: number;
  /** HCG Repo product pages; used for links only. */
  repoBaseUrl: string;
  publishing: PublishingSettings;
}

/**
 * Ship to Store (release publishing). Off unless HCG_STORE_PUBLISHING=enabled. Who may publish or approve is
 * decided by HCG's entitlement authority (central permission IDs), never by the Store.
 */
export interface PublishingSettings {
  enabled: boolean;
  /** HCG Connect client IDs whose access tokens may call the publishing API (e.g. HCG Executable Maker). */
  clientIds: string[];
  /** Central permission checked for publishing (edition = Store product ID, or "*" for every product). */
  publisherCentralId: string | null;
  /** Central permission checked for approving releases (edition = Store product ID, or "*"). */
  approverCentralId: string | null;
  maxUploadBytes: number;
  uploadUrlTtlSeconds: number;
  chunkBytes: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`HCG Store server configuration refused:\n- ${problems.join("\n- ")}`);
  }
}

type Env = Record<string, string | undefined>;

function httpsUrl(value: string | undefined, name: string, problems: string[], allowLoopbackHttp: boolean): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(allowLoopbackHttp && loopback && u.protocol === "http:")) {
      problems.push(`${name} must use https.`);
      return null;
    }
    if (u.username || u.password) {
      problems.push(`${name} must not contain credentials.`);
      return null;
    }
    return u.toString();
  } catch {
    problems.push(`${name} is not a valid URL.`);
    return null;
  }
}

function origin(value: string, name: string, problems: string[], allowLoopbackHttp: boolean): string | null {
  const u = httpsUrl(value, name, problems, allowLoopbackHttp);
  return u ? new URL(u).origin : null;
}

export function parseStoreConfig(env: Env): StoreConfig {
  const problems: string[] = [];
  const mode: StoreMode = env.HCG_STORE_MODE === "test" ? "test" : "production";
  if (env.HCG_STORE_MODE && !["test", "production"].includes(env.HCG_STORE_MODE)) {
    problems.push(`HCG_STORE_MODE must be "test" or "production".`);
  }
  const test = mode === "test";

  const publicOrigin = origin(env.HCG_STORE_PUBLIC_ORIGIN ?? (test ? "http://127.0.0.1:8787" : ""), "HCG_STORE_PUBLIC_ORIGIN", problems, test) ?? "";
  if (!publicOrigin && !test) problems.push("HCG_STORE_PUBLIC_ORIGIN is required.");
  const repoOrigins = (env.HCG_STORE_REPO_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => origin(o, "HCG_STORE_REPO_ORIGINS", problems, test))
    .filter((o): o is string => !!o);

  let secretKey: Buffer;
  if (env.HCG_STORE_SECRET_KEY) {
    secretKey = Buffer.from(env.HCG_STORE_SECRET_KEY, "base64");
    if (secretKey.length !== 32) problems.push("HCG_STORE_SECRET_KEY must be 32 bytes, base64-encoded.");
  } else if (test) {
    secretKey = randomBytes(32);
  } else {
    secretKey = Buffer.alloc(32);
    problems.push("HCG_STORE_SECRET_KEY is required in production.");
  }

  const connectFields = {
    issuer: env.HCG_CONNECT_ISSUER,
    authorizationEndpoint: env.HCG_CONNECT_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.HCG_CONNECT_TOKEN_ENDPOINT,
    jwksUri: env.HCG_CONNECT_JWKS_URI,
    clientId: env.HCG_CONNECT_CLIENT_ID,
    redirectUri: env.HCG_CONNECT_REDIRECT_URI,
  };
  const setCount = Object.values(connectFields).filter(Boolean).length;
  let hcgConnect: HcgConnectSettings | null = null;
  if (setCount > 0 && setCount < Object.keys(connectFields).length) {
    const missing = Object.entries(connectFields)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    problems.push(`HCG Connect is partly configured; missing: ${missing.join(", ")}.`);
  } else if (setCount > 0) {
    const issuer = httpsUrl(connectFields.issuer, "HCG_CONNECT_ISSUER", problems, test);
    const authorizationEndpoint = httpsUrl(connectFields.authorizationEndpoint, "HCG_CONNECT_AUTHORIZATION_ENDPOINT", problems, test);
    const tokenEndpoint = httpsUrl(connectFields.tokenEndpoint, "HCG_CONNECT_TOKEN_ENDPOINT", problems, test);
    const jwksUri = httpsUrl(connectFields.jwksUri, "HCG_CONNECT_JWKS_URI", problems, test);
    const redirectUri = httpsUrl(connectFields.redirectUri, "HCG_CONNECT_REDIRECT_URI", problems, test);
    if (redirectUri && publicOrigin && new URL(redirectUri).origin !== publicOrigin) {
      problems.push("HCG_CONNECT_REDIRECT_URI must be on HCG_STORE_PUBLIC_ORIGIN.");
    }
    if (issuer && authorizationEndpoint && tokenEndpoint && jwksUri && redirectUri) {
      hcgConnect = {
        // The issuer is compared exactly with the token's `iss`; keep it as configured (no trailing slash added).
        issuer: connectFields.issuer!,
        authorizationEndpoint,
        tokenEndpoint,
        jwksUri,
        clientId: connectFields.clientId!,
        redirectUri,
        scopes: env.HCG_CONNECT_SCOPES ?? "openid email profile",
      };
    }
  }

  const ecosystemUrl = httpsUrl(env.HCG_ECOSYSTEM_API_URL, "HCG_ECOSYSTEM_API_URL", problems, test);
  const ecosystem = ecosystemUrl ? { baseUrl: ecosystemUrl.replace(/\/$/, "") } : null;

  const authority = (env.HCG_STORE_ENTITLEMENT_AUTHORITY ?? "none") as StoreConfig["entitlementAuthority"];
  if (!["none", "test-ledger", "hcg-ecosystem"].includes(authority)) problems.push("HCG_STORE_ENTITLEMENT_AUTHORITY is not recognised.");
  if (authority === "test-ledger" && !test) problems.push("The test entitlement ledger can only be used in test mode.");
  if (authority === "hcg-ecosystem" && !ecosystem) problems.push("HCG_STORE_ENTITLEMENT_AUTHORITY=hcg-ecosystem needs HCG_ECOSYSTEM_API_URL.");

  const paymentProvider = (env.HCG_STORE_PAYMENT_PROVIDER ?? "none") as StoreConfig["paymentProvider"];
  if (!["none", "test"].includes(paymentProvider)) {
    problems.push(
      "HCG_STORE_PAYMENT_PROVIDER must be \"none\" or \"test\". No live payment provider is implemented: HCG has no approved payment integration yet.",
    );
  }
  if (paymentProvider === "test" && !test) problems.push("The test payment provider can only be used in test mode. Live payments are disabled.");
  const testPaymentWebhookSecret = env.HCG_STORE_TEST_PAYMENT_WEBHOOK_SECRET ?? (paymentProvider === "test" ? randomBytes(24).toString("hex") : null);

  const protectedDownloads = env.HCG_STORE_PROTECTED_DOWNLOADS === "enabled";
  if (env.HCG_STORE_PROTECTED_DOWNLOADS && !["enabled", "disabled"].includes(env.HCG_STORE_PROTECTED_DOWNLOADS)) {
    problems.push(`HCG_STORE_PROTECTED_DOWNLOADS must be "enabled" or "disabled".`);
  }
  if (protectedDownloads) {
    if (!hcgConnect) problems.push("Protected downloads need HCG Connect sign-in to be configured.");
    if (authority === "none") problems.push("Protected downloads need an entitlement authority.");
    if (!test && env.HCG_STORE_LAUNCH_APPROVED !== "founder-approved") {
      problems.push(
        "Protected downloads are a launch decision. In production they also need HCG_STORE_LAUNCH_APPROVED=founder-approved, set only after the founder approves launch.",
      );
    }
  }

  const int = (name: string, def: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}.`);
      return def;
    }
    return n;
  };

  const staticDir = env.HCG_STORE_STATIC_DIR ?? "dist";
  const artifactStorageDir = env.HCG_STORE_ARTIFACT_STORAGE_DIR ?? "";
  if (protectedDownloads && !artifactStorageDir) problems.push("Protected downloads need HCG_STORE_ARTIFACT_STORAGE_DIR (a private directory).");

  const repoBaseUrl = httpsUrl(env.HCG_REPO_BASE_URL ?? "https://repo.hakmicapitalgroup.com/", "HCG_REPO_BASE_URL", problems, test) ?? "";

  const publishingEnabled = env.HCG_STORE_PUBLISHING === "enabled";
  if (env.HCG_STORE_PUBLISHING && !["enabled", "disabled"].includes(env.HCG_STORE_PUBLISHING)) problems.push(`HCG_STORE_PUBLISHING must be "enabled" or "disabled".`);
  const centralPermission = /^[a-z0-9][a-z0-9._-]{1,79}$/;
  const publisherCentralId = env.HCG_STORE_PUBLISHER_CENTRAL_ID?.trim() || null;
  const approverCentralId = env.HCG_STORE_RELEASE_APPROVER_CENTRAL_ID?.trim() || null;
  const publishingClientIds = (env.HCG_STORE_PUBLISHING_CLIENT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (publishingEnabled) {
    if (!hcgConnect) problems.push("Publishing needs HCG Connect to be configured.");
    if (authority === "none") problems.push("Publishing needs an entitlement authority (HCG decides who may publish).");
    if (!artifactStorageDir) problems.push("Publishing needs HCG_STORE_ARTIFACT_STORAGE_DIR (a private directory).");
    if (!publisherCentralId || !centralPermission.test(publisherCentralId)) problems.push("Publishing needs HCG_STORE_PUBLISHER_CENTRAL_ID: the central permission HCG grants to publishers.");
    if (!approverCentralId || !centralPermission.test(approverCentralId)) problems.push("Publishing needs HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: the central permission HCG grants to release approvers.");
    if (publisherCentralId && publisherCentralId === approverCentralId) problems.push("Publisher and approver permissions must be different central IDs.");
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    mode,
    publicOrigin,
    repoOrigins,
    port: int("PORT", 8787, 1, 65535),
    host: env.HOST ?? "127.0.0.1",
    dataDir: env.HCG_STORE_DATA_DIR ?? (test ? ":memory:" : "data"),
    staticDir,
    catalogueDir: env.HCG_CATALOGUE_DIR ?? "catalogue",
    offersFile: env.HCG_STORE_OFFERS_FILE ?? "server/data/offers.json",
    artifactsFile: env.HCG_STORE_ARTIFACTS_FILE ?? "server/data/artifacts.json",
    artifactStorageDir,
    secretKey,
    hcgConnect,
    ecosystem,
    entitlementAuthority: authority,
    paymentProvider,
    testPaymentWebhookSecret,
    protectedDownloads,
    sessionRecheckSeconds: int("HCG_STORE_SESSION_RECHECK_SECONDS", 60, 0, 900),
    sessionIdleSeconds: int("HCG_STORE_SESSION_IDLE_SECONDS", 7 * 24 * 3600, 300, 30 * 24 * 3600),
    sessionAbsoluteSeconds: int("HCG_STORE_SESSION_ABSOLUTE_SECONDS", 30 * 24 * 3600, 3600, 90 * 24 * 3600),
    downloadUrlTtlSeconds: int("HCG_STORE_DOWNLOAD_URL_TTL_SECONDS", 120, 10, 900),
    repoBaseUrl,
    publishing: {
      enabled: publishingEnabled,
      clientIds: publishingClientIds,
      publisherCentralId,
      approverCentralId,
      maxUploadBytes: int("HCG_STORE_UPLOAD_MAX_MB", 4096, 1, 16384) * 1024 * 1024,
      uploadUrlTtlSeconds: int("HCG_STORE_UPLOAD_URL_TTL_SECONDS", 900, 60, 3600),
      chunkBytes: int("HCG_STORE_UPLOAD_CHUNK_MB", 8, 1, 64) * 1024 * 1024,
    },
  };
}
