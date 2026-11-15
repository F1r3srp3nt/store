/**
 * One access decision used by every surface (Store website, HCG Repo website, Sileo payment API),
 * so ownership is always reported the same way everywhere.
 */
import type { StoreConfig } from "./config";
import type { EntitlementAuthority } from "./entitlements";
import { currentReleaseOf, findEdition, offersFor, type Offer, type ProtectedArtifact, type Registry } from "./registry";
import type { SessionStore, Session } from "./sessions";
import type { Product } from "../../src/domain/schema";

export const DOWNLOADS_NOT_AVAILABLE = "Downloads are not available yet.";

export type AccessState = "signed-out" | "owned" | "not-owned" | "not-for-sale" | "unavailable";

export interface PublicOffer {
  id: string;
  title: string;
  kind: Offer["kind"];
  interval: Offer["interval"];
  currency: string;
  unitAmount: number;
  /** Editions a purchase grants, as configured in the licence. */
  grants: string[];
  testOnly: boolean;
}

export interface EditionAccess {
  productId: string;
  editionId: string | null;
  state: AccessState;
  signedIn: boolean;
  owned: boolean;
  /** Offers approved for sale. Prices are server-authoritative. */
  offers: PublicOffer[];
  checkoutReady: boolean;
  checkoutUnavailableReason: string | null;
  downloadsAvailable: boolean;
  downloadsMessage: string;
  /** Files the person may download now; only when downloadsAvailable. */
  artifacts: { id: string; fileName: string; releaseId: string }[];
  message: string | null;
}

export interface AccessDeps {
  cfg: StoreConfig;
  registry: Registry;
  authority: EntitlementAuthority;
  sessions: SessionStore;
  paymentsReady: boolean;
}

export function publicOffer(o: Offer): PublicOffer {
  return {
    id: o.id,
    title: o.title,
    kind: o.kind,
    interval: o.interval,
    currency: o.currency,
    unitAmount: o.unitAmount,
    grants: o.grants.map((g) => g.edition),
    testOnly: o.testOnly,
  };
}

export function deliverableArtifacts(reg: Registry, product: Product, editionId: string | null): ProtectedArtifact[] {
  return reg.artifacts.filter((a) => {
    if (a.productId !== product.id || a.editionId !== editionId || !a.deliveryApproved) return false;
    const rel = reg.catalogue.releases.find((r) => r.id === a.releaseId);
    return !!rel && rel.status === "approved";
  });
}

/**
 * @param session  An already re-confirmed session (see SessionStore.ensureFresh), or null.
 * @param sessionUnavailable  HCG Connect could not be reached to re-confirm the session.
 */
export async function decideAccess(
  deps: AccessDeps,
  product: Product,
  editionId: string | null,
  session: Session | null,
  sessionUnavailable = false,
): Promise<EditionAccess> {
  const { cfg, registry, authority } = deps;
  const offers = offersFor(registry, product, editionId).map(publicOffer);
  const released = !!currentReleaseOf(registry.catalogue, product);
  const centralId = product.registry.centralId;

  let checkoutUnavailableReason: string | null = null;
  if (!offers.length) checkoutUnavailableReason = released ? "Not for sale yet." : "Coming soon. Not for sale before release.";
  else if (!deps.paymentsReady) checkoutUnavailableReason = "Checkout is not available yet.";

  const base: EditionAccess = {
    productId: product.id,
    editionId,
    state: "signed-out",
    signedIn: false,
    owned: false,
    offers,
    checkoutReady: offers.length > 0 && deps.paymentsReady,
    checkoutUnavailableReason,
    downloadsAvailable: false,
    downloadsMessage: DOWNLOADS_NOT_AVAILABLE,
    artifacts: [],
    message: null,
  };

  if (sessionUnavailable) return { ...base, state: "unavailable", message: "Your access could not be checked right now. Try again shortly." };
  if (!session) return { ...base, message: "Sign in with HCG Connect to check access." };

  const signedIn = { ...base, signedIn: true };
  if (!centralId) {
    // Without a confirmed central product ID no entitlement can exist for this product.
    return { ...signedIn, state: offers.length ? "not-owned" : "not-for-sale" };
  }
  const check = await authority.check({ sub: session.sub, accessToken: session.accessToken }, centralId, editionId);
  if (check.status === "unavailable") {
    return { ...signedIn, state: "unavailable", message: "Your access could not be checked right now. Nothing has changed; try again shortly." };
  }
  if (check.status === "not-granted") return { ...signedIn, state: offers.length ? "not-owned" : "not-for-sale" };

  const files = deliverableArtifacts(registry, product, editionId);
  const downloadsAvailable = cfg.protectedDownloads && files.length > 0;
  return {
    ...signedIn,
    state: "owned",
    owned: true,
    downloadsAvailable,
    downloadsMessage: downloadsAvailable ? "Available to your HCG account." : DOWNLOADS_NOT_AVAILABLE,
    artifacts: downloadsAvailable ? files.map((a) => ({ id: a.id, fileName: a.fileName, releaseId: a.releaseId })) : [],
  };
}

export function editionIdsOf(product: Product): (string | null)[] {
  return product.editions.length ? product.editions.map((e) => e.id) : [null];
}

export function validEdition(product: Product, editionId: string | null): boolean {
  return product.editions.length ? !!findEdition(product, editionId) : editionId === null;
}
