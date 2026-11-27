import type { Catalogue } from "./catalogue";
import { listedProducts } from "./model";

/**
 * How access works in HCG Store, stated from what the Store server reports as switched on (health) and the public
 * catalogue. Never claims more than is enforced: unknown (static host, server unreachable) says only what is always true.
 */
/** The parts of HCG Store's public health answer (GET /api/v1/health) this uses. */
export interface AccessHealth {
  protectedDownloads: string;
  payments: string;
  anonymousFreeProducts?: string[];
}

export type AccessLaneId = "browse" | "anonymous" | "account" | "licensed" | "connect" | "purchases";
export interface AccessLane {
  id: AccessLaneId;
  title: string;
  state: string;
  tone: "open" | "account" | "later";
  text: string;
  /** Products this lane names (links). */
  products: { slug: string; name: string }[];
}

export function accessLanes(catalogue: Catalogue, health: AccessHealth | null): AccessLane[] {
  const listed = listedProducts(catalogue);
  const downloadsOn = !!health && health.protectedDownloads !== "disabled";
  const anonymous = downloadsOn
    ? (health?.anonymousFreeProducts ?? []).map((id) => listed.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p)
    : [];
  const names = anonymous.map((p) => p.name);
  const paymentsOff = !health || health.payments === "disabled" || health.payments === "none";
  return [
    {
      id: "browse",
      title: "Public browsing",
      state: "Open to everyone",
      tone: "open",
      text: "Every product page, edition, status and release note is public. Look around without an account.",
      products: [],
    },
    {
      id: "anonymous",
      title: "Free downloads, no account",
      state: anonymous.length ? "Available now" : "Where HCG allows it",
      tone: anonymous.length ? "open" : "later",
      text: anonymous.length
        ? `${list(names)} ${names.length === 1 ? "downloads" : "download"} free, with no HCG account and no payment. HCG approves this product by product; each product page says when it applies.`
        : "HCG can approve free releases for download without an account, product by product. Each product page says when it applies.",
      products: anonymous.map((p) => ({ slug: p.slug, name: p.name })),
    },
    {
      id: "account",
      title: "Downloads with your HCG account",
      state: "Sign in to download",
      tone: "account",
      text: "Other published releases download after you sign in. HCG Store checks access on its server for every file; files are never put at public links.",
      products: [],
    },
    {
      id: "licensed",
      title: "Licensed products",
      state: "Ownership checked by HCG",
      tone: "account",
      text: "Paid and licensed editions download only when HCG confirms your account owns them. An HCG role never counts as ownership.",
      products: [],
    },
    {
      id: "connect",
      title: "HCG Connect",
      state: "One HCG account",
      tone: "account",
      text: "Sign-in happens on HCG Connect, the HCG identity service, not on HCG Store. Your library shows what your account owns.",
      products: [],
    },
    {
      id: "purchases",
      title: "Purchases",
      state: paymentsOff ? "Not open yet" : "Available",
      tone: paymentsOff ? "later" : "account",
      text: paymentsOff
        ? "Nothing can be bought or charged in HCG Store yet. Free products never need a payment."
        : "Purchases run through HCG Store's checkout and appear in your library.",
      products: [],
    },
  ];
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
