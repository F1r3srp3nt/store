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
  beta: { label: "Beta" },
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
