/**
 * Commerce administration API as the website uses it (Payment Provider Studio, repository-package distribution,
 * developers and sales). The server authorises every request with HCG's central permissions; nothing here grants access.
 */
import { StoreApiError, StoreServerUnavailable } from "../account/api";

const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export interface ProviderProfile {
  name: string; description: string; icon: string; bannerMessage: string; bannerButton: string;
  availability: "disabled" | "internal" | "public"; repositories: string[]; protocols: string[]; paymentMode: "off" | "test";
}
export interface Channel {
  packageId: string; productId: string; editionId: string | null; status: "draft" | "active" | "suspended"; access: "free" | "account" | "paid";
  architectures: string[]; minIos: string | null; maxIos: string | null; updatePolicy: "all-updates" | "same-major"; repository: string; revision: number;
  updatedAt: number; updatedBy: string; productName: string | null;
  offers: { id: string; title: string; unitAmount: number; currency: string; kind: string; testOnly: boolean }[];
  files: { artifactId: string; releaseId: string; fileName: string; sha256: string; version: string | null; architectures: string[]; sizeBytes: number | null }[];
  warnings: string[];
}
export interface Developer { id: string; displayName: string; status: string; onboarding: { payoutAccount: string; tax: string; identity: string }; updatedAt: number }
export interface Agreement { id: string; developerId: string; commissionBps: number; effectiveFrom: number; effectiveTo: number | null; status: string; note: string | null }
export interface Overview {
  rights: { read: boolean; manage: boolean; offersPermission: boolean; founder: boolean };
  csrfToken?: string;
  profile: { value: ProviderProfile; revision: number; updatedAt: number | null; updatedBy: string | null };
  effective: ProviderProfile & { notes: string[] };
  gates: { publicApproved: boolean; paymentProvider: string; livePayments: false; protectedDownloads: boolean; endpoint: string; internalSource: string };
  channels: Channel[];
  products: { id: string; name: string; editions: { id: string; name: string; pricingModel: string; packages: string[] }[] }[];
  developers: Developer[];
  ownership: { productId: string; developerId: string; since: number }[];
  agreements: Agreement[];
}
export interface Health { checkedAt: number; endpoint: string; ok: boolean; checks: { id: string; ok: boolean; label: string; detail: string }[] }
export interface Preview { endpoint: string; info: { status: number; body: unknown }; packageInfo: { status: number; body: unknown } | null; authenticationCallback: string; paymentCallback: string }
export interface SalesRow {
  developerId: string | null; developerName: string; currency: string; test: boolean; purchases: number; gross: number; refunded: number; disputed: number; net: number;
  commission: number; developerShare: number; byChannel: Record<string, number>; payout: { eligible: boolean; reasons: string[] };
}

let csrf: string | null = null;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    if (csrf === null) await commerceApi.overview();
    headers["content-type"] = "application/json";
    headers["x-hcg-csrf"] = csrf ?? "";
  }
  let res: Response;
  try {
    res = await fetch(base() + path, { method, credentials: "same-origin", headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  } catch {
    throw new StoreServerUnavailable("HCG Store could not be reached.");
  }
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw new StoreServerUnavailable("This site has no HCG Store server.");
  const json = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new StoreApiError(res.status, json.error?.code ?? "error", json.error?.message ?? "Request failed.");
  return json;
}

const enc = encodeURIComponent;
export const commerceApi = {
  overview: async () => {
    const o = await call<Overview>("GET", "/api/v1/commerce/overview");
    csrf = o.csrfToken ?? null;
    return o;
  },
  saveProfile: (revision: number, profile: ProviderProfile) => call<{ profile: Overview["profile"] }>("PUT", "/api/v1/commerce/provider", { revision, profile }),
  health: () => call<Health>("GET", "/api/v1/commerce/provider/health"),
  preview: (pkg: string | null) => call<Preview>("GET", `/api/v1/commerce/provider/preview${pkg ? `?package=${enc(pkg)}` : ""}`),
  saveChannel: (packageId: string, c: Omit<Channel, "packageId" | "revision" | "updatedAt" | "updatedBy" | "productName" | "offers" | "files" | "warnings"> & { revision?: number }) =>
    call<{ channel: Channel }>("PUT", `/api/v1/commerce/channels/${enc(packageId)}`, c),
  saveDeveloper: (id: string, d: { displayName: string; status: string; onboarding: Developer["onboarding"] }) => call<{ developer: Developer }>("PUT", `/api/v1/commerce/developers/${enc(id)}`, d),
  setOwnership: (productId: string, developerId: string | null) => call<unknown>("PUT", `/api/v1/commerce/ownership/${enc(productId)}`, { developerId }),
  addAgreement: (a: { developerId: string; commissionBps: number; effectiveFrom: number; effectiveTo: number | null; note: string | null }) => call<{ agreement: Agreement }>("POST", "/api/v1/commerce/agreements", a),
  endAgreement: (id: string) => call<{ agreement: Agreement }>("POST", `/api/v1/commerce/agreements/${enc(id)}/end`),
  sales: (from: number, to: number) => call<{ rows: SalesRow[]; payoutsActive: boolean; source: string }>("GET", `/api/v1/commerce/sales?from=${from}&to=${to}`),
  audit: () => call<{ entries: { seq: number; at: number; actor: string; action: string; target: string | null; detail: Record<string, unknown> }[] }>("GET", "/api/v1/commerce/audit"),
};

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
