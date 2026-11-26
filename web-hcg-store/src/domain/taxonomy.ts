/** Controlled vocabularies for the catalogue. Changing an ID here is a breaking catalogue change. */

export const PLATFORMS = {
  windows: { label: "Windows" },
  macos: { label: "macOS" },
  linux: { label: "Linux" },
  ios: { label: "iOS" },
  ipados: { label: "iPadOS" },
  android: { label: "Android" },
  web: { label: "Web" },
} as const;
export type PlatformId = keyof typeof PLATFORMS;
export const PLATFORM_IDS = Object.keys(PLATFORMS) as [PlatformId, ...PlatformId[]];

/** How confident the catalogue is that a product runs on a platform. */
export const PLATFORM_SUPPORT = {
  confirmed: { label: "Supported", description: "Supported by a published, approved release." },
  "in-development": { label: "In development", description: "Being built for this platform. No release implied." },
  planned: { label: "Planned", description: "Intended for this platform. Work has not started or is not confirmed." },
} as const;
export type PlatformSupport = keyof typeof PLATFORM_SUPPORT;
export const PLATFORM_SUPPORT_IDS = Object.keys(PLATFORM_SUPPORT) as [PlatformSupport, ...PlatformSupport[]];

export const CATEGORIES = {
  "developer-tools": {
    label: "HCG Development Tools",
    description: "Build, packaging and engineering tools. An umbrella category, not a product.",
  },
  productivity: { label: "Productivity", description: "Planning, focus and everyday work." },
  communication: { label: "Communication", description: "Email and messaging." },
  "trading-markets": { label: "Trading & Markets", description: "Trading education and market tooling." },
  "news-media": { label: "News & Media", description: "News and publishing." },
  commerce: { label: "Marketplaces & Commerce", description: "Buying, selling and listings." },
  analytics: { label: "Analytics", description: "Measurement and insight." },
  security: { label: "Security & Testing", description: "Authorised testing of your own devices, networks and services." },
  infrastructure: { label: "Infrastructure & Servers", description: "Devices, storage and services you run yourself." },
  unclassified: { label: "Category to be confirmed", description: "Awaiting founder classification." },
} as const;
export type CategoryId = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as [CategoryId, ...CategoryId[]];

/** Development lifecycle. Deliberately independent from release availability. */
export const DEVELOPMENT_STATUS = {
  "in-development": { label: "In development", tone: "active" },
  planning: { label: "Planning", tone: "planned" },
  testing: { label: "Testing", tone: "active" },
  maintained: { label: "Maintained", tone: "stable" },
  paused: { label: "Paused", tone: "muted" },
  unknown: { label: "Status not stated", tone: "muted" },
} as const;
export type DevelopmentStatus = keyof typeof DEVELOPMENT_STATUS;
export const DEVELOPMENT_STATUS_IDS = Object.keys(DEVELOPMENT_STATUS) as [DevelopmentStatus, ...DevelopmentStatus[]];

export const RELEASE_CHANNELS = {
  alpha: { label: "Alpha" },
  beta: { label: "Public beta" },
  stable: { label: "Stable" },
} as const;
export type ReleaseChannel = keyof typeof RELEASE_CHANNELS;
export const RELEASE_CHANNEL_IDS = Object.keys(RELEASE_CHANNELS) as [ReleaseChannel, ...ReleaseChannel[]];

export const ARTIFACT_FORMATS = {
  exe: "Windows executable / installer (.exe)",
  msi: "Windows Installer package (.msi)",
  msix: "MSIX package (.msix)",
  zip: "ZIP archive (.zip)",
  dmg: "macOS disk image (.dmg)",
  pkg: "macOS installer package (.pkg)",
  ipa: "iOS app archive (.ipa)",
  apk: "Android package (.apk)",
  aab: "Android App Bundle (.aab), for authorised distribution only",
  appimage: "Linux AppImage",
  deb: "Debian package (.deb)",
  rpm: "RPM package (.rpm)",
  "tar.gz": "Compressed tarball (.tar.gz)",
} as const;
export type ArtifactFormat = keyof typeof ARTIFACT_FORMATS;
export const ARTIFACT_FORMAT_IDS = Object.keys(ARTIFACT_FORMATS) as [ArtifactFormat, ...ArtifactFormat[]];

/**
 * Signing state as REPORTED by the catalogue. HCG Store never verifies signatures itself and
 * never presents these values as a safety guarantee.
 */
export const SIGNING_STATUS = {
  "not-stated": "Not stated",
  unsigned: "Unsigned (stated by HCG)",
  signed: "Signed (stated by HCG)",
  notarized: "Signed and notarised (stated by HCG)",
} as const;
export type SigningStatus = keyof typeof SIGNING_STATUS;
export const SIGNING_STATUS_IDS = Object.keys(SIGNING_STATUS) as [SigningStatus, ...SigningStatus[]];

/** Intended distribution channel of an edition. A channel never implies the edition is available there. */
export const EDITION_CHANNELS = {
  "app-store": { label: "App Store / TestFlight (intended)" },
  "jailbreak-package": { label: "Jailbreak package via HCG Repo" },
  "direct-download": { label: "Direct download via HCG Store" },
  sideload: { label: "Development install (Xcode) only" },
} as const;
export type EditionChannel = keyof typeof EDITION_CHANNELS;
export const EDITION_CHANNEL_IDS = Object.keys(EDITION_CHANNELS) as [EditionChannel, ...EditionChannel[]];

/**
 * Catalogue v2. Four separate concepts, never merged:
 * - edition tier: which variant of the product (Standard, Professional, Founder Beta, Developer, Unleashed);
 * - pricing model: how HCG intends to charge (free, paid, subscription), or not set yet; prices live only in offers;
 * - release channel: alpha / beta / stable, per release;
 * - development status: per product.
 * "Coming soon" is derived (no approved current release), never stored.
 */
export const EDITION_TIERS = {
  standard: { label: "Standard" },
  professional: { label: "Professional" },
  "founder-beta": { label: "Founder Beta" },
  developer: { label: "Developer" },
  unleashed: { label: "Unleashed" },
} as const;
export type EditionTier = keyof typeof EDITION_TIERS;
export const EDITION_TIER_IDS = Object.keys(EDITION_TIERS) as [EditionTier, ...EditionTier[]];

export const PRICING_MODELS = {
  free: { label: "Free" },
  paid: { label: "Paid" },
  subscription: { label: "Subscription" },
  "not-set": { label: "Pricing not set" },
} as const;
export type PricingModel = keyof typeof PRICING_MODELS;
export const PRICING_MODEL_IDS = Object.keys(PRICING_MODELS) as [PricingModel, ...PricingModel[]];

/** What HCG Connect requires before an edition can be used or downloaded. Decided centrally; this is the Store's statement. */
export const ACCESS_REQUIREMENTS = {
  none: { label: "No HCG account needed" },
  "hcg-account": { label: "Sign-in with an HCG account" },
  licence: { label: "HCG licence for this edition" },
  unknown: { label: "Access requirement not stated" },
} as const;
export type AccessRequirement = keyof typeof ACCESS_REQUIREMENTS;
export const ACCESS_REQUIREMENT_IDS = Object.keys(ACCESS_REQUIREMENTS) as [AccessRequirement, ...AccessRequirement[]];

export const BUILD_PROVIDERS = {
  local: { label: "Local build" },
  "github-actions": { label: "GitHub Actions" },
  "hcg-server-build-host": { label: "HCG Server Build Host" },
} as const;
export type BuildProvider = keyof typeof BUILD_PROVIDERS;
export const BUILD_PROVIDER_IDS = Object.keys(BUILD_PROVIDERS) as [BuildProvider, ...BuildProvider[]];

export const IDENTIFIER_KINDS = {
  "bundle-id": "Bundle identifier",
  "debian-package": "Package identifier",
  "app-id": "Application ID",
} as const;
export type IdentifierKind = keyof typeof IDENTIFIER_KINDS;
export const IDENTIFIER_KIND_IDS = Object.keys(IDENTIFIER_KINDS) as [IdentifierKind, ...IdentifierKind[]];
