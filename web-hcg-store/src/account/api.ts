/**
 * Client for the HCG Store server (same origin). The browser never holds an HCG token: it has only
 * an HttpOnly session cookie, and every decision about ownership, prices and downloads is made by
 * the server. Nothing here is trusted for access control.
 */

export interface SessionInfo {
  configured: boolean;
  signedIn: boolean;
  user: { sub: string; email: string | null; name: string | null } | null;
  centralCheck?: "unavailable";
  endedReason?: string;
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
  artifacts: { id: string; fileName: string; releaseId: string }[];
  message: string | null;
}

export interface Library {
  owned: { productId: string; slug: string; name: string; editionId: string | null; editionName: string | null; state: string }[];
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
  ownershipUnavailable: boolean;
  downloadsMessage: string | null;
}

export interface Health {
  status: "ok";
  mode: "test" | "production";
  hcgConnect: "configured" | "not-configured";
  entitlementAuthority: "none" | "test-ledger" | "hcg-ecosystem";
  payments: string;
  protectedDownloads: "enabled" | "disabled";
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

export const storeApi = {
  session: () => request<SessionInfo>("/api/v1/session"),
  health: () => request<Health>("/api/v1/health"),
  access: (slug: string) => request<{ productId: string; signedIn: boolean; editions: EditionAccess[] }>(`/api/v1/products/${encodeURIComponent(slug)}/access`),
  library: () => request<Library>("/api/v1/library"),
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
