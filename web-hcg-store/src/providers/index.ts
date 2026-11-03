import { runtimeConfig } from "../config/runtime";
import { createErpCatalogueProvider } from "./erp";
import { localCatalogueProvider } from "./local";
import type { CatalogueProvider } from "./types";

/**
 * Chooses the catalogue provider from configuration. There is deliberately no silent fallback:
 * if the ERP provider is selected but unavailable, the UI says so instead of showing seed data.
 */
export function selectCatalogueProvider(): CatalogueProvider {
  return runtimeConfig.catalogueProvider === "hcg-erp"
    ? createErpCatalogueProvider(runtimeConfig.erpCatalogueUrl)
    : localCatalogueProvider;
}

export type { CatalogueProvider, CatalogueLoadResult, CatalogueSource } from "./types";
