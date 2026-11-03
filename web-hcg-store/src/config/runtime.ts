import { parseDeploymentConfig, type DeploymentConfig } from "./deployment";

export interface RuntimeConfig {
  deployment: DeploymentConfig;
  catalogueProvider: "local" | "hcg-erp";
  erpCatalogueUrl: string | undefined;
  /** Raw public env, used by the HCG Connect configuration parser. */
  env: Record<string, string | undefined>;
}

export function readRuntimeConfig(env: Record<string, string | boolean | undefined>): RuntimeConfig {
  const strings: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith("VITE_") && typeof v === "string") strings[k] = v;
  return {
    deployment: parseDeploymentConfig(env),
    catalogueProvider: strings.VITE_CATALOGUE_PROVIDER === "hcg-erp" ? "hcg-erp" : "local",
    erpCatalogueUrl: strings.VITE_HCG_ERP_CATALOGUE_URL?.trim() || undefined,
    env: strings,
  };
}

export const runtimeConfig: RuntimeConfig = readRuntimeConfig(import.meta.env as Record<string, string | boolean | undefined>);
