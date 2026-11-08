/**
 * HCG Connect (central identity) configuration.
 *
 * All values are PUBLIC (a public OAuth client ID is not a secret). There are no defaults:
 * nothing about the central protocol is assumed from the existence of a login page.
 */

export interface HcgConnectField {
  key: string;
  label: string;
  kind: "https-url" | "text" | "redirect-uri" | "scopes" | "flag";
}

export const HCG_CONNECT_FIELDS: HcgConnectField[] = [
  { key: "VITE_HCG_CONNECT_CONTRACT_VERSION", label: "Agreed contract version", kind: "text" },
  { key: "VITE_HCG_CONNECT_AUTHORIZATION_ENDPOINT", label: "Authorization endpoint", kind: "https-url" },
  { key: "VITE_HCG_CONNECT_TOKEN_ENDPOINT", label: "Token endpoint", kind: "https-url" },
  { key: "VITE_HCG_CONNECT_REVOCATION_ENDPOINT", label: "Revocation endpoint", kind: "https-url" },
  { key: "VITE_HCG_CONNECT_APP_ACCESS_ENDPOINT", label: "App Access endpoint", kind: "https-url" },
  { key: "VITE_HCG_CONNECT_CLIENT_ID", label: "Public client ID (registered for HCG Store)", kind: "text" },
  { key: "VITE_HCG_CONNECT_REDIRECT_URI", label: "Approved redirect URI", kind: "redirect-uri" },
  { key: "VITE_HCG_CONNECT_SCOPES", label: "Approved scopes", kind: "scopes" },
  { key: "VITE_HCG_CONNECT_APP_IDENTIFIER", label: "HCG Store App Access identifier", kind: "text" },
  { key: "VITE_HCG_CONNECT_APPROVED_BY_FOUNDER", label: "Founder approval flag", kind: "flag" },
];

export interface HcgConnectConfig {
  contractVersion: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  appAccessEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  appIdentifier: string;
}

export type HcgConnectConfigState =
  | { state: "not-configured"; missing: HcgConnectField[] }
  | { state: "invalid"; problems: string[] }
  | { state: "ready"; config: HcgConnectConfig };

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

export function parseHcgConnectConfig(env: Record<string, string | undefined>, currentOrigin: string): HcgConnectConfigState {
  const get = (k: string) => env[k]?.trim() || undefined;
  const missing = HCG_CONNECT_FIELDS.filter((f) => !get(f.key));
  // Nothing set at all: plainly "not configured".
  if (missing.length === HCG_CONNECT_FIELDS.length) return { state: "not-configured", missing };

  const problems: string[] = missing.map((f) => `${f.label} (${f.key}) is missing.`);
  for (const f of HCG_CONNECT_FIELDS) {
    const v = get(f.key);
    if (!v) continue;
    if (f.kind === "https-url" || f.kind === "redirect-uri") {
      let u: URL | null = null;
      try {
        u = new URL(v);
      } catch {
        problems.push(`${f.label} is not a valid URL.`);
        continue;
      }
      if (u.username || u.password) problems.push(`${f.label} must not contain credentials.`);
      const httpOk = f.kind === "redirect-uri" && u.protocol === "http:" && isLocalHost(u.hostname);
      if (u.protocol !== "https:" && !httpOk) problems.push(`${f.label} must use https.`);
      if (f.kind === "redirect-uri" && u.origin !== currentOrigin) {
        problems.push(`${f.label} (${u.origin}) does not match the origin this store is served from (${currentOrigin}).`);
      }
    }
    if (f.kind === "flag" && v !== "true") problems.push("Founder approval flag is not set to true.");
  }
  if (problems.length) return { state: "invalid", problems };

  return {
    state: "ready",
    config: {
      contractVersion: get("VITE_HCG_CONNECT_CONTRACT_VERSION")!,
      authorizationEndpoint: get("VITE_HCG_CONNECT_AUTHORIZATION_ENDPOINT")!,
      tokenEndpoint: get("VITE_HCG_CONNECT_TOKEN_ENDPOINT")!,
      revocationEndpoint: get("VITE_HCG_CONNECT_REVOCATION_ENDPOINT")!,
      appAccessEndpoint: get("VITE_HCG_CONNECT_APP_ACCESS_ENDPOINT")!,
      clientId: get("VITE_HCG_CONNECT_CLIENT_ID")!,
      redirectUri: get("VITE_HCG_CONNECT_REDIRECT_URI")!,
      scopes: get("VITE_HCG_CONNECT_SCOPES")!.split(/[\s,]+/).filter(Boolean),
      appIdentifier: get("VITE_HCG_CONNECT_APP_IDENTIFIER")!,
    },
  };
}
