/**
 * HCG Store commerce administration: the package-manager payment provider's profile and gates, the repository-package
 * distribution channel, and third-party developer records (ownership, commission agreements, sales reporting).
 *
 * HCG Store's catalogue and offers stay the commercial authority. Nothing here sets a price, records a payment or keeps
 * a balance:
 * - prices come only from the server's offers (registry.ts);
 * - payments and refunds are recorded only by the payment ledger from verified provider events (payments.ts);
 * - sales reports are computed from those purchase records;
 * - payouts are never made from HCG Store. Payout eligibility is reported and is always "not eligible" until automated
 *   payouts exist in HCG Payments, with provider onboarding, tax and identity checks done there.
 *
 * Every change is audited (commerce_audit) with the HCG account that made it. Optimistic revisions stop two people
 * from overwriting each other's edits.
 */
import { z } from "zod";
import type { StoreConfig } from "./config";
import { randomToken } from "./crypto";
import { transaction, type Db } from "./db";
import { HttpError } from "./http";
import { findProduct, offersFor, type Registry } from "./registry";

// ---------------------------------------------------------------- provider profile

export const PROTOCOLS = ["sileo-payment-provider-v1"] as const;
export type ProviderAvailability = "disabled" | "internal" | "public";

/** HCG Store's official provider profile (founder brief, 27 Nov 2026). Branding the Studio can change; gates it cannot. */
export const PROVIDER_DEFAULTS = {
  name: "HCG Store",
  description: "Official payment and distribution services for Hakmi Capital Group.",
  /** Path on the Store's own origin, or an https URL. The official HCG Store icon (public/brand/icon-512.png). */
  icon: "/brand/icon-512.png",
  bannerMessage: "Sign in with your HCG account to purchase packages and access your existing purchases.",
  bannerButton: "Sign in with HCG Connect",
  availability: "disabled" as ProviderAvailability,
  /** APT sources whose packages this provider may authorise (the `repo` Sileo and Zebra send). */
  repositories: [] as string[],
  protocols: ["sileo-payment-provider-v1"] as (typeof PROTOCOLS)[number][],
  /** "off": no purchases from package managers; "test": the TEST provider (test mode only). Never "live" here. */
  paymentMode: "off" as "off" | "test",
};

const httpsOrPath = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v.startsWith("/brand/") || /^https:\/\/[^\s/]+\/\S*$/.test(v), "Use the official artwork under /brand/ or an https URL.");

export const ProviderProfileSchema = z.strictObject({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(10).max(240),
  icon: httpsOrPath,
  bannerMessage: z.string().trim().min(10).max(200),
  bannerButton: z.string().trim().min(2).max(40),
  availability: z.enum(["disabled", "internal", "public"]),
  repositories: z.array(z.string().trim().max(300)).max(10),
  protocols: z.array(z.enum(PROTOCOLS)).min(1),
  paymentMode: z.enum(["off", "test"]),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/** Lower-case scheme and host, no query or fragment, exactly one trailing slash: how repositories are compared. */
export function normalizeRepo(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- channel and developers

export const ARCHITECTURES = ["iphoneos-arm", "iphoneos-arm64", "iphoneos-arm64e"] as const;
const iosVersion = z.string().regex(/^\d{1,2}(?:\.\d{1,2}){0,2}$/, "An iOS version such as 15.0 or 16.4.1");
const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ChannelInput = z.strictObject({
  productId: z.string().regex(kebab),
  editionId: z.string().regex(kebab).nullable(),
  status: z.enum(["draft", "active", "suspended"]),
  /** free: public in HCG Repo's pool (never through this provider); account: any signed-in HCG account; paid: an entitlement. */
  access: z.enum(["free", "account", "paid"]),
  architectures: z.array(z.enum(ARCHITECTURES)).min(1),
  minIos: iosVersion.nullable().default(null),
  maxIos: iosVersion.nullable().default(null),
  /** all-updates: every later version; same-major: versions with the major version bought (purchases record it). */
  updatePolicy: z.enum(["all-updates", "same-major"]),
  repository: z.string().trim().max(300),
  revision: z.number().int().positive().optional(),
});
export type ChannelInputT = z.infer<typeof ChannelInput>;

export interface Channel {
  packageId: string;
  productId: string;
  editionId: string | null;
  status: "draft" | "active" | "suspended";
  access: "free" | "account" | "paid";
  architectures: string[];
  minIos: string | null;
  maxIos: string | null;
  updatePolicy: "all-updates" | "same-major";
  repository: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export const PackageIdPattern = /^[a-z0-9][a-z0-9.+-]{1,127}$/;

const Onboarding = z.strictObject({
  payoutAccount: z.enum(["not-started", "in-progress", "complete"]).default("not-started"),
  tax: z.enum(["not-started", "in-progress", "complete"]).default("not-started"),
  identity: z.enum(["not-started", "in-progress", "complete"]).default("not-started"),
});
export const DeveloperInput = z.strictObject({
  displayName: z.string().trim().min(2).max(80),
  status: z.enum(["draft", "active", "suspended"]),
  onboarding: Onboarding.default({ payoutAccount: "not-started", tax: "not-started", identity: "not-started" }),
});
export const AgreementInput = z.strictObject({
  developerId: z.string().regex(kebab),
  /** HCG's commission in basis points (2000 = 20 %) of net sales; the rest is the developer's share. */
  commissionBps: z.number().int().min(0).max(10000),
  effectiveFrom: z.number().int().positive(),
  effectiveTo: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});

type ChannelRow = {
  package_id: string; product_id: string; edition_id: string | null; status: Channel["status"]; access: Channel["access"]; architectures: string;
  min_ios: string | null; max_ios: string | null; update_policy: Channel["updatePolicy"]; repository: string; revision: number; created_at: number; updated_at: number; updated_by: string;
};
const channelOf = (r: ChannelRow): Channel => ({
  packageId: r.package_id, productId: r.product_id, editionId: r.edition_id, status: r.status, access: r.access, architectures: JSON.parse(r.architectures) as string[],
  minIos: r.min_ios, maxIos: r.max_ios, updatePolicy: r.update_policy, repository: r.repository, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

/** Compares Debian-style dotted numeric versions by their leading major number ("1.4.0-2" → 1). */
export function majorOf(version: string): number | null {
  const m = /^(?:\d+:)?(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

export class Commerce {
  constructor(
    private readonly db: Db,
    private readonly cfg: StoreConfig,
    private readonly registry: Registry,
    private readonly now: () => number,
  ) {}

  // ------------------------------------------------------------ audit

  audit(actor: string, action: string, target: string | null, detail: Record<string, unknown> = {}) {
    this.db.prepare("INSERT INTO commerce_audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(this.now(), actor, action, target, JSON.stringify(detail));
  }

  auditLog(limit = 200) {
    return (this.db.prepare("SELECT seq, at, actor, action, target, detail FROM commerce_audit ORDER BY seq DESC LIMIT ?").all(limit) as { seq: number; at: number; actor: string; action: string; target: string | null; detail: string }[])
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown }));
  }

  // ------------------------------------------------------------ provider profile

  private setting<T>(key: string): { value: T; revision: number; updatedAt: number; updatedBy: string | null } | null {
    const r = this.db.prepare("SELECT value, revision, updated_at, updated_by FROM commerce_settings WHERE key = ?").get(key) as { value: string; revision: number; updated_at: number; updated_by: string | null } | undefined;
    return r ? { value: JSON.parse(r.value) as T, revision: r.revision, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
  }

  /** The stored profile (defaults until someone saves one). The default repository is HCG Repo's APT source. */
  profile(): { value: ProviderProfile; revision: number; updatedAt: number | null; updatedBy: string | null } {
    const s = this.setting<ProviderProfile>("provider-profile");
    const defaults: ProviderProfile = { ...PROVIDER_DEFAULTS, repositories: this.cfg.repoBaseUrl ? [`${this.cfg.repoBaseUrl.replace(/\/+$/, "")}/repo/`] : [] };
    if (!s) return { value: defaults, revision: 0, updatedAt: null, updatedBy: null };
    return { value: { ...defaults, ...s.value }, revision: s.revision, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
  }

  /**
   * What is actually in force: the stored profile capped by the server's own configuration.
   * - "public" needs HCG_STORE_SILEO_PUBLIC_APPROVED=founder-approved in production; otherwise it acts as "internal".
   * - Payments are "test" only when the TEST provider is configured (test mode); live payments do not exist.
   */
  effective() {
    const { value } = this.profile();
    const reasons: string[] = [];
    let availability = value.availability;
    if (availability === "public" && !this.cfg.sileo.publicApproved) {
      availability = "internal";
      reasons.push("Public availability is a launch decision: it also needs HCG_STORE_SILEO_PUBLIC_APPROVED=founder-approved on the server. Running as internal testing.");
    }
    let paymentMode: "off" | "test" = value.paymentMode;
    if (paymentMode === "test" && this.cfg.paymentProvider !== "test") {
      paymentMode = "off";
      reasons.push("TEST payments need the TEST payment provider, which only runs in test mode. Purchases from package managers are off.");
    }
    const icon = value.icon.startsWith("/") ? `${this.cfg.publicOrigin}${value.icon}` : value.icon;
    const repositories = value.repositories.map(normalizeRepo).filter((x): x is string => !!x);
    return { ...value, availability, paymentMode, icon, repositories, notes: reasons };
  }

  updateProfile(actor: string, input: unknown, expectedRevision: number) {
    const value = ProviderProfileSchema.parse(input);
    const problems: string[] = [];
    for (const r of value.repositories) {
      const n = normalizeRepo(r);
      if (!n) problems.push(`"${r}" is not a repository URL.`);
      else if (!n.startsWith("https://") && this.cfg.mode !== "test") problems.push(`${n}: package managers only accept https repositories.`);
    }
    if (value.availability !== "disabled" && !value.repositories.length) problems.push("Associate at least one repository before making the provider available.");
    if (problems.length) throw new HttpError(400, "invalid_profile", problems.join(" "));
    return transaction(this.db, () => {
      const cur = this.profile();
      if (cur.revision !== expectedRevision) throw new HttpError(409, "stale_revision", "Someone changed the provider profile since you loaded it. Reload and apply your change again.");
      const t = this.now();
      const stored = { ...value, repositories: value.repositories.map((r) => normalizeRepo(r)!) };
      this.db
        .prepare("INSERT INTO commerce_settings (key, value, revision, updated_at, updated_by) VALUES ('provider-profile', ?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
        .run(JSON.stringify(stored), t, actor);
      const changed = (Object.keys(stored) as (keyof ProviderProfile)[]).filter((k) => JSON.stringify(stored[k]) !== JSON.stringify(cur.value[k]));
      this.audit(actor, "provider.profile-updated", "provider-profile", { changed, availability: stored.availability, paymentMode: stored.paymentMode });
      return this.profile();
    });
  }

  // ------------------------------------------------------------ repository-package channel

  channels(): Channel[] {
    return (this.db.prepare("SELECT * FROM repo_packages ORDER BY product_id, package_id").all() as ChannelRow[]).map(channelOf);
  }

  channel(packageId: string): Channel | null {
    const r = this.db.prepare("SELECT * FROM repo_packages WHERE package_id = ?").get(packageId) as ChannelRow | undefined;
    return r ? channelOf(r) : null;
  }

  /** Problems that stop a channel from being saved (the catalogue's mapping and the offers are the authority). */
  channelProblems(packageId: string, c: ChannelInputT): string[] {
    const out: string[] = [];
    if (!PackageIdPattern.test(packageId)) out.push("The package identifier must be a Debian package name (lower case letters, digits, . + -).");
    const product = findProduct(this.registry, c.productId);
    if (!product || product.id !== c.productId) return [...out, `Unknown catalogue product "${c.productId}".`];
    const edition = c.editionId ? product.editions.find((e) => e.id === c.editionId) : null;
    if (product.editions.length && !edition) out.push(`"${c.productId}" has no edition "${c.editionId ?? ""}".`);
    if (!product.editions.length && c.editionId) out.push(`"${c.productId}" has no editions.`);
    // The public catalogue maps package identifiers to editions; the channel never invents a mapping.
    if (edition && !edition.identifiers.some((i) => i.kind === "debian-package" && i.value === packageId)) {
      out.push(`The catalogue does not list ${packageId} as a package of ${product.name} (${edition.name}). Add it to the edition's identifiers first (npm run validate:catalogue).`);
    }
    const repo = normalizeRepo(c.repository);
    if (!repo) out.push("The repository must be the APT source URL, e.g. https://repo.hakmicapitalgroup.com/repo/.");
    else if (!repo.startsWith("https://") && this.cfg.mode !== "test") out.push("Package managers only use https repositories.");
    if (c.minIos && c.maxIos && compareDotted(c.minIos, c.maxIos) > 0) out.push("The minimum iOS version is above the maximum.");
    const sold = offersFor(this.registry, product, c.editionId ?? null);
    if (c.access !== "paid" && sold.length) out.push(`This edition has offers approved for sale (${sold.map((o) => o.id).join(", ")}). A sold edition is distributed as "paid".`);
    if (c.access === "paid" && edition?.pricingModel === "free") out.push("The catalogue says this edition is free; it cannot be distributed as paid.");
    return out;
  }

  upsertChannel(actor: string, packageId: string, input: unknown): Channel {
    const c = ChannelInput.parse(input);
    const problems = this.channelProblems(packageId, c);
    if (problems.length) throw new HttpError(400, "invalid_channel", problems.join(" "));
    const owner = this.db.prepare("SELECT package_id, product_id FROM repo_packages WHERE package_id = ?").get(packageId) as { product_id: string } | undefined;
    return transaction(this.db, () => {
      const cur = this.channel(packageId);
      if (cur && c.revision !== cur.revision) throw new HttpError(409, "stale_revision", "Someone changed this package's distribution since you loaded it. Reload and apply your change again.");
      if (!cur && c.revision !== undefined) throw new HttpError(409, "stale_revision", "This package's distribution was removed since you loaded it.");
      if (owner && owner.product_id !== c.productId) throw new HttpError(409, "package_owned", "This package identifier is already associated with another product.");
      const t = this.now();
      const row = [c.productId, c.editionId, c.status, c.access, JSON.stringify([...new Set(c.architectures)].sort()), c.minIos, c.maxIos, c.updatePolicy, normalizeRepo(c.repository)!];
      if (cur) {
        this.db.prepare("UPDATE repo_packages SET product_id = ?, edition_id = ?, status = ?, access = ?, architectures = ?, min_ios = ?, max_ios = ?, update_policy = ?, repository = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE package_id = ?").run(...row, t, actor, packageId);
      } else {
        this.db.prepare("INSERT INTO repo_packages (product_id, edition_id, status, access, architectures, min_ios, max_ios, update_policy, repository, revision, created_at, updated_at, updated_by, package_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)").run(...row, t, t, actor, packageId);
      }
      const next = this.channel(packageId)!;
      this.audit(actor, cur ? "channel.updated" : "channel.created", packageId, {
        productId: next.productId, editionId: next.editionId, status: next.status, access: next.access, previousStatus: cur?.status ?? null, previousAccess: cur?.access ?? null,
      });
      return next;
    });
  }

  // ------------------------------------------------------------ developers, ownership, agreements

  developers() {
    return (this.db.prepare("SELECT * FROM developers ORDER BY display_name").all() as { id: string; display_name: string; status: string; onboarding: string; created_at: number; updated_at: number; updated_by: string }[])
      .map((d) => ({ id: d.id, displayName: d.display_name, status: d.status, onboarding: JSON.parse(d.onboarding) as z.infer<typeof Onboarding>, createdAt: d.created_at, updatedAt: d.updated_at, updatedBy: d.updated_by }));
  }

  upsertDeveloper(actor: string, id: string, input: unknown) {
    if (!kebab.test(id) || id.length > 60) throw new HttpError(400, "invalid_developer", "Developer IDs are lower-case words joined by hyphens.");
    const d = DeveloperInput.parse(input);
    const t = this.now();
    const exists = this.db.prepare("SELECT 1 FROM developers WHERE id = ?").get(id);
    if (exists) this.db.prepare("UPDATE developers SET display_name = ?, status = ?, onboarding = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(d.displayName, d.status, JSON.stringify(d.onboarding), t, actor, id);
    else this.db.prepare("INSERT INTO developers (id, display_name, status, onboarding, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, d.displayName, d.status, JSON.stringify(d.onboarding), t, t, actor);
    this.audit(actor, exists ? "developer.updated" : "developer.created", id, { status: d.status, onboarding: d.onboarding });
    return this.developers().find((x) => x.id === id)!;
  }

  ownership() {
    return (this.db.prepare("SELECT product_id, developer_id, since, updated_by FROM product_developers ORDER BY product_id").all() as { product_id: string; developer_id: string; since: number; updated_by: string }[])
      .map((r) => ({ productId: r.product_id, developerId: r.developer_id, since: r.since, updatedBy: r.updated_by }));
  }

  /** developerId null: first-party HCG product (the default for every product without a record). */
  setOwnership(actor: string, productId: string, developerId: string | null) {
    if (!findProduct(this.registry, productId)) throw new HttpError(404, "not_found", "Unknown catalogue product.");
    if (developerId && !this.db.prepare("SELECT 1 FROM developers WHERE id = ?").get(developerId)) throw new HttpError(404, "not_found", "Unknown developer.");
    if (developerId) this.db.prepare("INSERT INTO product_developers (product_id, developer_id, since, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET developer_id = excluded.developer_id, since = excluded.since, updated_by = excluded.updated_by").run(productId, developerId, this.now(), actor);
    else this.db.prepare("DELETE FROM product_developers WHERE product_id = ?").run(productId);
    this.audit(actor, "ownership.set", productId, { developerId });
    return this.ownership();
  }

  agreements() {
    return (this.db.prepare("SELECT * FROM developer_agreements ORDER BY developer_id, effective_from").all() as { id: string; developer_id: string; commission_bps: number; effective_from: number; effective_to: number | null; status: string; note: string | null; created_at: number; created_by: string }[])
      .map((a) => ({ id: a.id, developerId: a.developer_id, commissionBps: a.commission_bps, effectiveFrom: a.effective_from, effectiveTo: a.effective_to, status: a.status, note: a.note, createdAt: a.created_at, createdBy: a.created_by }));
  }

  /** Agreements are never edited in place: a new one is added, and an old one can be ended. Overlaps are refused. */
  addAgreement(actor: string, input: unknown) {
    const a = AgreementInput.parse(input);
    if (!this.db.prepare("SELECT 1 FROM developers WHERE id = ?").get(a.developerId)) throw new HttpError(404, "not_found", "Unknown developer.");
    if (a.effectiveTo !== null && a.effectiveTo <= a.effectiveFrom) throw new HttpError(400, "invalid_agreement", "An agreement must end after it starts.");
    const overlapping = this.agreements().filter((x) => x.developerId === a.developerId && x.status === "active" && x.effectiveFrom < (a.effectiveTo ?? Infinity) && a.effectiveFrom < (x.effectiveTo ?? Infinity));
    if (overlapping.length) throw new HttpError(409, "agreement_overlap", `This overlaps agreement ${overlapping[0]!.id}. End it first.`);
    const id = `agr_${randomToken(9)}`;
    this.db.prepare("INSERT INTO developer_agreements (id, developer_id, commission_bps, effective_from, effective_to, status, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(id, a.developerId, a.commissionBps, a.effectiveFrom, a.effectiveTo, a.note, this.now(), actor);
    this.audit(actor, "agreement.added", id, { developerId: a.developerId, commissionBps: a.commissionBps, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo });
    return this.agreements().find((x) => x.id === id)!;
  }

  endAgreement(actor: string, id: string, at: number) {
    const a = this.agreements().find((x) => x.id === id);
    if (!a) throw new HttpError(404, "not_found", "Unknown agreement.");
    if (a.status !== "active") throw new HttpError(409, "agreement_ended", "This agreement has already ended.");
    const end = Math.max(at, a.effectiveFrom + 1);
    this.db.prepare("UPDATE developer_agreements SET status = 'ended', effective_to = ? WHERE id = ?").run(a.effectiveTo !== null ? Math.min(a.effectiveTo, end) : end, id);
    this.audit(actor, "agreement.ended", id, { developerId: a.developerId, endedAt: end });
    return this.agreements().find((x) => x.id === id)!;
  }

  /**
   * Sales report computed from the payment ledger's purchase records (never a second ledger). Amounts are in minor
   * units per currency. TEST purchases are reported separately and never count towards a developer's share.
   * Payout eligibility is always false while automated payouts are not activated.
   */
  salesReport(from: number, to: number) {
    const rows = this.db.prepare("SELECT id, offer_id, provider, amount, currency, status, channel, created_at FROM purchases WHERE created_at >= ? AND created_at < ?").all(from, to) as {
      id: string; offer_id: string; provider: string; amount: number; currency: string; status: string; channel: string; created_at: number;
    }[];
    const owners = new Map(this.ownership().map((o) => [o.productId, o.developerId]));
    const agreements = this.agreements();
    const devs = new Map(this.developers().map((d) => [d.id, d]));
    type Bucket = { developerId: string | null; currency: string; test: boolean; gross: number; refunded: number; disputed: number; net: number; commission: number; developerShare: number; purchases: number; byChannel: Record<string, number>; missingAgreement: number };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const offer = this.registry.offers.find((o) => o.id === r.offer_id);
      const developerId = offer ? (owners.get(offer.productId) ?? null) : null;
      const test = r.provider === "test" || !!offer?.testOnly;
      const key = `${developerId ?? "hcg"}|${r.currency}|${test ? "test" : "live"}`;
      const b = buckets.get(key) ?? { developerId, currency: r.currency, test, gross: 0, refunded: 0, disputed: 0, net: 0, commission: 0, developerShare: 0, purchases: 0, byChannel: {}, missingAgreement: 0 };
      b.purchases += 1;
      b.gross += r.amount;
      b.byChannel[r.channel] = (b.byChannel[r.channel] ?? 0) + 1;
      if (r.status === "refunded") b.refunded += r.amount;
      else if (r.status === "disputed") b.disputed += r.amount;
      else {
        b.net += r.amount;
        if (developerId) {
          const ag = agreements.find((a) => a.developerId === developerId && a.effectiveFrom <= r.created_at && (a.effectiveTo === null || r.created_at < a.effectiveTo));
          if (!ag) b.missingAgreement += 1;
          else {
            const commission = Math.round((r.amount * ag.commissionBps) / 10000);
            b.commission += commission;
            b.developerShare += r.amount - commission;
          }
        } else b.commission += r.amount; // first-party: all of it stays with HCG
      }
      buckets.set(key, b);
    }
    return {
      from, to, generatedAt: this.now(),
      source: "HCG Store purchase records (payment ledger). No separate balance is kept.",
      payoutsActive: false,
      rows: [...buckets.values()].map((b) => {
        const d = b.developerId ? devs.get(b.developerId) : null;
        const reasons: string[] = ["Automated third-party payouts are not activated. They need HCG Payments' payout provider onboarding, tax and identity checks, and founder approval."];
        if (d) {
          if (d.status !== "active") reasons.push(`The developer is ${d.status}.`);
          for (const [k, v] of Object.entries(d.onboarding)) if (v !== "complete") reasons.push(`${k === "payoutAccount" ? "Payout account" : k === "tax" ? "Tax details" : "Identity verification"}: ${v.replace("-", " ")}.`);
        }
        if (b.test) reasons.push("TEST purchases never count towards a payout.");
        if (b.missingAgreement) reasons.push(`${b.missingAgreement} purchase(s) fall outside any commission agreement.`);
        return { ...b, developerName: d?.displayName ?? (b.developerId ? b.developerId : "Hakmi Capital Group (first party)"), payout: { eligible: false, reasons: b.developerId ? reasons : ["First-party sales: no payout."] } };
      }),
    };
  }
}

/** Compares two dotted numeric versions ("16.4" vs "16.4.1"). */
export function compareDotted(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
