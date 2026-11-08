/**
 * Deployment configuration shared by the Vite build (Node) and the browser app.
 *
 * Everything here is PUBLIC configuration. Values come from `VITE_*` variables and are
 * embedded in the shipped JavaScript, so nothing secret may ever be configured through them.
 */

export const DEPLOY_ENVS = ["development", "preview", "production"] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/**
 * The planned production host. It is NOT live yet; it may only be configured together with
 * an explicit `VITE_DEPLOY_ENV=production`.
 */
export const FUTURE_PRODUCTION_HOST = "store.hakmicapitalgroup.com";

export interface DeploymentConfig {
  deployEnv: DeployEnv;
  /** Normalised origin (scheme + host + optional port), or null when not configured. */
  publicOrigin: string | null;
  /** True only for an explicit production build with indexing enabled and an origin set. */
  indexingAllowed: boolean;
  fixtureMode: boolean;
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | boolean | undefined>;

const str = (env: Env, key: string): string | undefined => {
  const v = env[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normaliseOrigin(raw: string): { origin: string; host: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `VITE_PUBLIC_ORIGIN "${raw}" is not a valid URL.` };
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    return { error: "VITE_PUBLIC_ORIGIN must use https (http is accepted only for localhost)." };
  }
  if (url.username || url.password) return { error: "VITE_PUBLIC_ORIGIN must not contain credentials." };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { error: "VITE_PUBLIC_ORIGIN must be an origin only (no path, query or fragment)." };
  }
  return { origin: url.origin, host: url.hostname };
}

export function parseDeploymentConfig(env: Env): DeploymentConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawEnv = str(env, "VITE_DEPLOY_ENV") ?? "development";
  let deployEnv: DeployEnv = "development";
  if ((DEPLOY_ENVS as readonly string[]).includes(rawEnv)) {
    deployEnv = rawEnv as DeployEnv;
  } else {
    errors.push(`VITE_DEPLOY_ENV must be one of ${DEPLOY_ENVS.join(", ")} (got "${rawEnv}").`);
  }

  let publicOrigin: string | null = null;
  const rawOrigin = str(env, "VITE_PUBLIC_ORIGIN");
  if (rawOrigin) {
    const parsed = normaliseOrigin(rawOrigin);
    if ("error" in parsed) {
      errors.push(parsed.error);
    } else {
      publicOrigin = parsed.origin;
      if (parsed.host === FUTURE_PRODUCTION_HOST && deployEnv !== "production") {
        errors.push(
          `${FUTURE_PRODUCTION_HOST} is the future production domain and is not live. ` +
            "Configure it only in an explicit production build (VITE_DEPLOY_ENV=production).",
        );
      }
    }
  }

  const wantsIndexing = str(env, "VITE_ALLOW_INDEXING") === "true";
  let indexingAllowed = false;
  if (wantsIndexing) {
    if (deployEnv !== "production") {
      warnings.push("VITE_ALLOW_INDEXING is ignored outside production builds; this build stays noindex.");
    } else if (!publicOrigin) {
      errors.push("Production indexing requires VITE_PUBLIC_ORIGIN to be set.");
    } else {
      indexingAllowed = true;
    }
  }

  const fixtureMode = str(env, "VITE_FIXTURE_MODE") === "true";
  if (fixtureMode && deployEnv === "production") {
    errors.push("Fixture (test) catalogue data must never be built for production.");
  }
  if (fixtureMode) indexingAllowed = false;

  return { deployEnv, publicOrigin, indexingAllowed, fixtureMode, errors, warnings };
}

/** Names that suggest a credential. Any such VITE_ variable would be embedded in the public bundle. */
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PRIVATE|SERVICE_ROLE|TOKEN|API_KEY|APIKEY|ACCESS_KEY|CREDENTIAL)/i;

export function findSecretLikePublicEnvNames(env: Env): string[] {
  return Object.keys(env).filter((k) => k.startsWith("VITE_") && SECRET_NAME.test(k));
}
