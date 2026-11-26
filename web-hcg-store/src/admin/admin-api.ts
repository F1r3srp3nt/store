/**
 * HCG Store management API, as the website uses it. The same versioned API serves HCG Executable Maker and HCG Store
 * Manager (bearer tokens); the website uses the HttpOnly Store session plus a per-session CSRF token. Nothing here is
 * trusted for access control: the server authorises every request with HCG's central permissions.
 */
import { StoreApiError, StoreServerUnavailable } from "../account/api";

const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export interface Me {
  sub: string;
  email: string | null;
  permissions: { submit: boolean; approve: boolean; publish: boolean; offers: boolean };
  administrator: boolean;
  publishingMode: "disabled" | "uploads" | "enabled";
  capabilities: { uploads: boolean; approval: boolean; publication: boolean; publicDelivery: boolean; offers: boolean };
  devicePolicy: { mode: string; note: string };
  csrfToken?: string;
}

export interface Target { editionId: string | null; platform: string; arch: string; channel: string; current: boolean; currentRelease: string | null }
export interface Lifecycle { review: string; availability: string; currency: "current" | "superseded" | "not-current"; label: string }
export interface AdminArtifact {
  id: string; fileName: string; platform: string; format: string; architectures: string[]; sizeBytes: number; declaredSha256: string; sha256: string | null;
  status: string; receivedBytes: number; kind?: string; readiness: { label: string; status: string; ordinaryInstall: boolean };
  validation: { problems?: string[]; signatureStructure?: string } | null; signingReported: { status: string };
  provenance: { buildProvider: string | null; sourceCommit: string | null; passport?: { provider: string | null; runId: string | null; commit: string | null } } | null;
  customerDelivery: boolean;
}
export interface AdminRelease {
  id: string; productId: string; productTitle: string; productSource: "catalogue" | "draft"; editionId: string | null; version: string; build: string; channel: string;
  status: string; stage: string; availability: string; availabilityReason: string | null; revision: number; lifecycle: Lifecycle; targets: Target[];
  requestedEligibility: string; approvedEligibility: string | null; distribution: string; releaseNotes: string[]; knownLimitations: string[];
  createdAt: number; submittedAt: number | null; approvedAt: number | null; publishedAt: number | null; supersededBy: string | null; withdrawnReason: string | null;
  supersedePreviousOnPublish: boolean; uploadSource: { via: string; client: string | null } | null; reviewUrl: string;
  artifacts?: AdminArtifact[]; files?: number; audit?: { seq: number; at: number; actor: string; action: string; detail: Record<string, unknown> }[];
  mayApprove?: boolean; mayPublish?: boolean; mayPublication?: boolean;
}
export interface AdminProduct { id: string; title: string; source: "catalogue" | "draft"; editions: { id: string; name: string; platforms: unknown }[]; centralId: string | null; revision?: number }
export interface ProductDetail {
  id: string; slug: string | null; source: "catalogue" | "draft"; revision: number | null; editable: boolean; centralId: string | null; note: string;
  metadata: DraftMetadata & { visibility?: string };
  current: { editionId: string | null; platform: string; arch: string; channel: string; releaseId: string; version: string | null; build: string | null; availability: string | null; status: string | null; selectedAt: number }[];
  releaseCounts: Record<string, number>;
}
export interface DraftMetadata {
  title: string; summary: string; description: string[]; categories: string[]; platforms: string[]; editions: { id: string; name: string }[];
  systemRequirements: { platform: string; minimumOs: string | null; notes: string[] }[]; documentationUrl: string | null; supportUrl: string | null; visibility: string;
}
export interface Capabilities {
  maxUploadBytes: number; chunkBytes: number; formats: Record<string, Record<string, string>>; staffOnlyFormats: string[];
  storage: { usedBytes: number; quotaBytes: number | null }; publishingMode: string;
}
export interface NewRelease {
  productId: string; editionId: string | null; version: string; build: string; channel: "beta" | "stable"; releaseNotes: string[]; knownLimitations: string[];
  distribution: "free" | "paid" | "subscription" | "entitlement"; eligibility: "private" | "internal-testing" | "public"; supersedePreviousOnPublish: boolean;
  compatibility?: { minimumOs: Record<string, string>; architectures: string[]; notes: string[] };
}

let csrf: string | null = null;

async function call<T>(method: string, path: string, body?: unknown, opts: { revision?: number; allow?: number[] } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Changes always send JSON (an empty object when there is nothing to say); reads send no body.
  const payload = method === "GET" ? undefined : JSON.stringify(body ?? {});
  if (payload !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    if (csrf === null) await adminApi.me();
    headers["x-hcg-csrf"] = csrf ?? "";
  }
  if (opts.revision !== undefined) headers["if-match"] = `"${opts.revision}"`;
  let res: Response;
  try {
    res = await fetch(base() + path, { method, credentials: "same-origin", headers, body: payload });
  } catch {
    throw new StoreServerUnavailable("HCG Store could not be reached.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new StoreServerUnavailable("This site has no HCG Store server.");
  const json = (await res.json()) as T & { error?: { code: string; message: string } | string; message?: string };
  if (!res.ok && !opts.allow?.includes(res.status)) {
    const code = typeof json.error === "string" ? json.error : json.error?.code ?? "error";
    const message = typeof json.error === "string" ? json.message ?? "Request failed." : json.error?.message ?? "Request failed.";
    throw new StoreApiError(res.status, code, message);
  }
  return json;
}

const enc = encodeURIComponent;
export const adminApi = {
  me: async () => {
    const me = await call<Me>("GET", "/api/v1/publishing/me");
    csrf = me.csrfToken ?? null;
    return me;
  },
  capabilities: () => call<Capabilities>("GET", "/api/v1/publishing/capabilities"),
  products: (scope: "publish" | "review" = "publish") => call<{ products: AdminProduct[] }>("GET", `/api/v1/publishing/products${scope === "review" ? "?scope=review" : ""}`),
  product: (id: string) => call<ProductDetail>("GET", `/api/v1/publishing/products/${enc(id)}`),
  createDraftProduct: (id: string, title: string, metadata: Partial<DraftMetadata>) => call<{ id: string }>("POST", "/api/v1/publishing/products", { id, title, metadata }),
  updateDraftProduct: (id: string, patch: Partial<DraftMetadata>, revision: number) => call<ProductDetail>("PATCH", `/api/v1/publishing/products/${enc(id)}`, patch, { revision }),
  manager: (productId?: string, archived = false) =>
    call<{ releases: AdminRelease[]; auditIntact: boolean }>("GET", `/api/v1/publishing/manager?${new URLSearchParams({ ...(productId ? { productId } : {}), ...(archived ? { include: "archived" } : {}) })}`),
  release: (id: string) => call<AdminRelease & { auditIntact: boolean }>("GET", `/api/v1/publishing/releases/${enc(id)}`),
  createRelease: (r: NewRelease) => call<AdminRelease>("POST", "/api/v1/publishing/releases", r),
  declareArtifact: (releaseId: string, a: { fileName: string; platform: string; format: string; sizeBytes: number; sha256: string; architectures: string[]; minimumOs: string | null }) =>
    call<{ artifact: AdminArtifact; uploadUrl: string; chunkBytes: number; expiresAt: number }>("POST", `/api/v1/publishing/releases/${enc(releaseId)}/artifacts`, {
      ...a, buildProvider: "manual-upload", signing: { status: "not-checked", evidence: null, tool: null },
    }),
  renewUploadUrl: (artifactId: string) => call<{ received: number; uploadUrl: string; chunkBytes: number }>("POST", `/api/v1/publishing/artifacts/${enc(artifactId)}/upload-url`),
  complete: (artifactId: string) => call<{ artifact: AdminArtifact; message?: string }>("POST", `/api/v1/publishing/artifacts/${enc(artifactId)}/complete`, undefined, { allow: [422] }),
  attachPassport: (artifactId: string, passport: unknown) => call<{ artifact: AdminArtifact }>("POST", `/api/v1/publishing/artifacts/${enc(artifactId)}/passport`, passport),
  removeArtifact: (artifactId: string) => call<AdminRelease>("DELETE", `/api/v1/publishing/artifacts/${enc(artifactId)}`),
  submit: (id: string, revision: number) => call<AdminRelease>("POST", `/api/v1/publishing/releases/${enc(id)}/submit`, undefined, { revision }),
  approve: (id: string, revision: number, body: { eligibility: string; confirm: string; current: boolean }) => call<AdminRelease>("POST", `/api/v1/publishing/releases/${enc(id)}/approve`, body, { revision }),
  publish: (id: string, revision: number, body: { confirm: string; supersedePrevious: boolean }) => call<AdminRelease & { switch: SwitchResult }>("POST", `/api/v1/publishing/releases/${enc(id)}/publish`, body, { revision }),
  lifecycle: (id: string, op: "disable" | "enable" | "archive" | "revoke" | "withdraw", revision: number, reason: string, confirm?: string) =>
    call<AdminRelease>("POST", `/api/v1/publishing/releases/${enc(id)}/${op}`, op === "withdraw" ? { reason } : { reason, ...(confirm ? { confirm } : {}) }, { revision }),
  switchCurrent: (id: string, op: "supersede" | "restore", revision: number, confirm: string, reason: string) =>
    call<AdminRelease & { switch: SwitchResult }>("POST", `/api/v1/publishing/releases/${enc(id)}/${op}`, { confirm, reason }, { revision }),
  verifyChecksums: (id: string) => call<{ ok: boolean; files: { fileName: string; expected: string | null; actual: string | null; ok: boolean }[] }>("POST", `/api/v1/publishing/releases/${enc(id)}/verify-checksums`, undefined, { allow: [409] }),
  downloadUrl: (artifactId: string) => call<{ url: string; sha256: string }>("POST", `/api/v1/publishing/artifacts/${enc(artifactId)}/download-url`),
  changes: (since: number) => call<{ latestSeq: number; changes: { seq: number; action: string; releaseId: string | null; productId: string | null }[] }>("GET", `/api/v1/publishing/changes?since=${since}`),
};

export interface SwitchResult {
  switched: { target: { platform: string; arch: string; channel: string; editionKey: string }; previous: string | null }[];
  kept: { target: { platform: string; arch: string; channel: string }; current: string }[];
  superseded: string[];
}

/** For the existing Release Manager page: the CSRF token of this session. */
export async function csrfHeader(): Promise<Record<string, string>> {
  if (csrf === null) await adminApi.me().catch(() => undefined);
  return csrf ? { "x-hcg-csrf": csrf } : {};
}
