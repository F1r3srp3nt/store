import { parseDeploymentConfig, type DeploymentConfig } from "./deployment";

export const DEFAULT_HCG_REPO_BASE_URL = "https://repo.hakmicapitalgroup.com/";

export interface RuntimeConfig {
  deployment: DeploymentConfig;
  catalogueProvider: "local" | "hcg-erp";
  erpCatalogueUrl: string | undefined;
  /** Base URL of HCG Repo's website (product pages live at <base>products/<key>/). */
  repoBaseUrl: string;
  /** Raw public env (non-secret settings only). */
  env: Record<string, string | undefined>;
}

export function readRuntimeConfig(env: Record<string, string | boolean | undefined>): RuntimeConfig {
  const strings: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith("VITE_") && typeof v === "string") strings[k] = v;
  return {
    deployment: parseDeploymentConfig(env),
    catalogueProvider: strings.VITE_CATALOGUE_PROVIDER === "hcg-erp" ? "hcg-erp" : "local",
    erpCatalogueUrl: strings.VITE_HCG_ERP_CATALOGUE_URL?.trim() || undefined,
    repoBaseUrl: normaliseRepoBase(strings.VITE_HCG_REPO_BASE_URL),
    env: strings,
  };
}



/** Only an https URL without credentials, query or fragment is accepted; anything else falls back to the default. */
export function normaliseRepoBase(raw: string | undefined): string {
  if (!raw) return DEFAULT_HCG_REPO_BASE_URL;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return DEFAULT_HCG_REPO_BASE_URL;
    return u.toString().endsWith("/") ? u.toString() : `${u.toString()}/`;
  } catch {
    return DEFAULT_HCG_REPO_BASE_URL;
  }
}

/** HCG Repo product page for a product key from the catalogue's explicit mapping. */
export function hcgRepoProductUrl(key: string, base = runtimeConfig.repoBaseUrl): string {
  return new URL(`products/${encodeURIComponent(key)}/`, base).toString();
}

export const runtimeConfig: RuntimeConfig = readRuntimeConfig(import.meta.env as Record<string, string | boolean | undefined>);
