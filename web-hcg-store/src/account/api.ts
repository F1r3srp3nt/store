/**
 * Client for the HCG Store server (same origin). The browser never holds an HCG token: it has only
 * an HttpOnly session cookie, and every decision about ownership, prices and downloads is made by
 * the server. Nothing here is trusted for access control.
 */

export interface SessionInfo {
  configured: boolean;
  signedIn: boolean;
  user: { sub: string; email: string | null; name: string | null } | null;
  /** HCG Store's presentation of the account (display name, designation). Grants nothing. */
  profile?: { displayName: string | null; designation: string | null } | null;
  centralCheck?: "unavailable";
  endedReason?: string;
}

/** One registered HCG product and what HCG's /access reports for this account (read server-side). Display only. */
export interface MyApp {
  centralProductId: string | null;
  name: string;
  storeProductId: string | null;
  slug: string | null;
  /** HCG's registry status (in_development, planned, live, …). */
  hcgReleaseStatus: string | null;
  /** HCG Store's own release availability, separate from access. */
  storeRelease: "released" | "not-released" | "not-in-store";
  access: {
    state: "owner" | "licensed" | "none" | "unknown" | "not-registered";
    source: string | null;
    editions: "all" | string[];
    features: { available: string[]; notAvailable: number };
  };
  download: "available" | "not-released" | "not-in-store" | "not-registered" | "not-available" | "not-entitled";
  manage: string | null;
}

export interface MyApps {
  centralStatus: "ok" | "unavailable";
  displayName: string | null;
  ownerAccess: { label: string; source: string } | null;
  apps: MyApp[];
}

/** "free": a release approved as public and free; any signed-in HCG account may download it. Not ownership. */
export type AccessState = "signed-out" | "owned" | "free" | "not-owned" | "not-for-sale" | "unavailable";

export interface PublicOffer {
  id: string;
  title: string;
  kind: "one-time" | "subscription";
  interval: "month" | "year" | null;
  currency: string;
  unitAmount: number;
  grants: string[];
  testOnly: boolean;
}

/** Public facts about a published file, from the HCG Store server (never a URL). */
export interface AccessFileDetails {
  version: string;
  channel: string;
  architectures: string[];
  platform: string;
  format: string;
  sizeBytes: number;
  sha256: string | null;
  minimumOs: string | null;
  signing: string;
  publishedAt: number | null;
}

export interface AccessFile {
  id: string;
  fileName: string;
  releaseId: string;
  details?: AccessFileDetails | null;
}

export interface EditionAccess {
  productId: string;
  editionId: string | null;
  state: AccessState;
  signedIn: boolean;
  owned: boolean;
  offers: PublicOffer[];
  checkoutReady: boolean;
  checkoutUnavailableReason: string | null;
  downloadsAvailable: boolean;
  downloadsMessage: string;
  artifacts: AccessFile[];
  /** No HCG account is needed to download these files. */
  anonymous?: boolean;
  message: string | null;
  /** An open free testing window for this edition (server-side), with its end. Not a price. */
  freeTesting?: { endsAt: number } | null;
}

export interface Library {
  owned: {
    productId: string; slug: string; name: string; editionId: string | null; editionName: string | null; state: string;
    /** "licensed": HCG reports access (licence, grant or Founder/Owner); "free": a published free release, no ownership. */
    acquisition?: "licensed" | "free"; licence?: string; tier?: string | null; pricingModel?: string;
    /** The catalogue's explicit current release; null = not released yet. */
    currentRelease?: { id: string; version: string; channel: string; releaseDate: string | null } | null;
    hcgRepoKey?: string | null; channel?: string | null;
  }[];
  purchases: {
    id: string;
    title: string;
    productId: string | null;
    editionId: string | null;
    amount: number;
    currency: string;
    kind: string;
    status: string;
    currentPeriodEnd: number | null;
    createdAt: number;
    testOnly: boolean;
  }[];
  subscriptions?: Library["purchases"];
  invoices?: { available: boolean; items: unknown[]; message: string };
  devices?: { kind: string; label: string; connectedAt: number }[];
  devicesNote?: string;
  ownershipUnavailable: boolean;
  downloadsMessage: string | null;
}

export interface Health {
  status: "ok";
  mode: "test" | "production";
  hcgConnect: "configured" | "not-configured";
  entitlementAuthority: "none" | "test-ledger" | "hcg-ecosystem";
  payments: string;
  protectedDownloads: "enabled" | "free-testing-only" | "disabled";
  /** Products whose free public releases download without an HCG account (founder-approved, product by product). */
  anonymousFreeProducts?: string[];
  publishing?: string;
}

export class StoreApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The account server is missing (e.g. a static-only preview host). */
export class StoreServerUnavailable extends Error {}

export const DOWNLOADS_NOT_AVAILABLE = "Downloads are not available yet.";

const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new StoreServerUnavailable("HCG Store's account service could not be reached.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new StoreServerUnavailable("This site has no HCG Store account service.");
  const body = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new StoreApiError(res.status, body.error?.code ?? "error", body.error?.message ?? "Request failed.");
  return body;
}

/** Release Manager (Ship to Store): metadata only, shown to the people HCG lets publish or approve a product. */
export type ReleaseStage =
  | "draft" | "validation-pending" | "validation-failed" | "uploaded" | "awaiting-approval"
  | "approved" | "published" | "superseded" | "withdrawn";
export interface ManagedRelease {
  id: string; productId: string; productTitle: string; productSource: "catalogue" | "draft"; editionId: string | null;
  version: string; build: string; channel: string; status: string; stage: ReleaseStage; approvedEligibility: string | null;
  requestedEligibility: string; distribution: string; createdAt: number; submittedAt: number | null; approvedAt: number | null;
  publishedAt: number | null; supersededBy: string | null; withdrawnReason: string | null; files: number; reviewUrl: string;
  mayApprove: boolean; mayPublish: boolean; mayPublication?: boolean;
}
export interface ChecksumReport { ok: boolean; checkedAt: number; files: { id: string; fileName: string; expected: string | null; actual: string | null; ok: boolean }[] }
export interface ReleaseComparison {
  from: { id: string; version: string; build: string }; to: { id: string; version: string; build: string };
  fields: { field: string; from: unknown; to: unknown }[];
  releaseNotes: { added: string[]; removed: string[] };
  files: { change: "added" | "removed" | "changed" | "identical"; platform: string; format: string; architectures: string[]; sizeDelta?: number }[];
}

export const storeApi = {
  session: () => request<SessionInfo>("/api/v1/session"),
  health: () => request<Health>("/api/v1/health"),
  access: (slug: string) => request<{ productId: string; signedIn: boolean; editions: EditionAccess[] }>(`/api/v1/products/${encodeURIComponent(slug)}/access`),
  library: () => request<Library>("/api/v1/library"),
  myApps: () => request<MyApps>("/api/v1/my-apps"),
  releaseManager: () => request<{ releases: ManagedRelease[]; auditIntact: boolean }>("/api/v1/publishing/manager"),
  /** A mismatch answers 409 with the same report, so both are read here. */
  verifyChecksums: async (id: string): Promise<ChecksumReport> => {
    const { csrfHeader } = await import("../admin/admin-api");
    const res = await fetch(`${base()}/api/v1/publishing/releases/${encodeURIComponent(id)}/verify-checksums`, {
      method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json", ...(await csrfHeader()) }, body: "{}",
    });
    const body = (await res.json()) as ChecksumReport & { error?: { code: string; message: string } };
    if (res.ok || (res.status === 409 && Array.isArray(body.files))) return body;
    throw new StoreApiError(res.status, body.error?.code ?? "error", body.error?.message ?? "Request failed.");
  },
  compareReleases: (from: string, to: string) =>
    request<ReleaseComparison>(`/api/v1/publishing/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  checkout: (offerId: string) => request<{ checkoutId: string; redirectUrl: string; testMode: boolean }>("/api/v1/checkout", { method: "POST", body: JSON.stringify({ offerId }) }),
  checkoutStatus: (id: string) =>
    request<{ id: string; status: "open" | "pending" | "completed" | "failed"; productId: string | null; editionId: string | null; title: string | null }>(
      `/api/v1/checkout/${encodeURIComponent(id)}`,
    ),
  logout: () => request<{ signedIn: false }>("/auth/logout", { method: "POST", body: "{}" }),
};

/** Full-page navigation to HCG Connect sign-in (the server handles PKCE and the callback). */
export function signInUrl(returnTo: string): string {
  return `${base()}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

export function downloadUrl(artifactId: string): string {
  return `${base()}/api/v1/downloads/${encodeURIComponent(artifactId)}`;
}

export function formatPrice(o: Pick<PublicOffer, "unitAmount" | "currency" | "kind" | "interval">): string {
  let amount: string;
  try {
    amount = new Intl.NumberFormat("en", { style: "currency", currency: o.currency }).format(o.unitAmount / 100);
  } catch {
    amount = `${(o.unitAmount / 100).toFixed(2)} ${o.currency}`;
  }
  return o.kind === "subscription" && o.interval ? `${amount} per ${o.interval}` : amount;
}
