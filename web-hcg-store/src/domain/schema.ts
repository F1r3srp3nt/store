import { z } from "zod";
import {
  ARTIFACT_FORMAT_IDS,
  CATEGORY_IDS,
  DEVELOPMENT_STATUS_IDS,
  EDITION_CHANNEL_IDS,
  IDENTIFIER_KIND_IDS,
  PLATFORM_IDS,
  PLATFORM_SUPPORT_IDS,
  RELEASE_CHANNEL_IDS,
  SIGNING_STATUS_IDS,
} from "./taxonomy";
import { isSemver } from "./version";

/** Bump when the catalogue file format changes incompatibly. */
export const CATALOGUE_SCHEMA_VERSION = 1;

const kebab = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase kebab-case (a-z, 0-9 and single hyphens).");
const text = z.string().trim().min(1);
/** Media path relative to the site base, e.g. "media/products/x/shot.webp". No schemes, no "..". */
const relativeAsset = z
  .string()
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+$/, "Use a relative path inside public/ (no leading slash, no '..', no URL).");

export const MediaSchema = z.strictObject({
  /** "screenshot" = a real capture of the software. "concept" = artwork that does not depict a working app. */
  kind: z.enum(["screenshot", "concept"]),
  src: relativeAsset,
  alt: text,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  caption: text,
  /** Optional smaller renditions for responsive loading (srcset). */
  variants: z.array(z.strictObject({ src: relativeAsset, width: z.number().int().positive() })).default([]),
  /** Where the asset came from (repository, path, commit, build). Required for traceability. */
  provenance: text,
});

export const PlatformEntrySchema = z
  .strictObject({
    platform: z.enum(PLATFORM_IDS),
    support: z.enum(PLATFORM_SUPPORT_IDS),
    /** Only for confirmed support. */
    architectures: z.array(text).default([]),
    /** Only for confirmed support, when verified. */
    minimumOs: text.nullable().default(null),
    note: text.nullable().default(null),
  })
  .superRefine((p, ctx) => {
    if (p.support !== "confirmed" && (p.architectures.length > 0 || p.minimumOs !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "Architectures and minimum OS may only be stated for confirmed platform support. Use 'note' for development details.",
      });
    }
  });

/** A separately built edition or platform-specific build of a product, as declared by its development repository. */
export const EditionSchema = z.strictObject({
  id: kebab,
  name: text,
  summary: text,
  platforms: z.array(z.enum(PLATFORM_IDS)).min(1),
  /** Intended distribution channel. Never implies the edition is available there. */
  channel: z.enum(EDITION_CHANNEL_IDS),
  /** The development or release state of this edition, as stated by HCG. */
  status: text,
  /** Bundle identifiers and package identifiers declared in the edition's own build configuration. */
  identifiers: z.array(z.strictObject({ kind: z.enum(IDENTIFIER_KIND_IDS), value: text })).default([]),
  /** Package layouts (e.g. iphoneos-arm64 rootless) that the build tooling declares. Not a compatibility promise. */
  layouts: z.array(z.strictObject({ architecture: text, label: text, note: text.nullable().default(null) })).default([]),
  note: text.nullable().default(null),
  /**
   * The key HCG's central licensing uses for this edition: a module-scope licence with scope_key
   * "edition:<key>" (decision D2). Null = not mapped centrally. An unmapped edition is never checked
   * against a product-wide grant or another edition: its central check reports "access unknown".
   */
  centralEditionKey: kebab.nullable().default(null),
});

/** Product artwork: an icon and/or a cover image from an approved source, with provenance. */
export const ArtworkImageSchema = z.strictObject({
  src: relativeAsset,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Empty alt only for purely decorative art next to the product name. */
  alt: z.string(),
  provenance: text,
  /** "official" = supplied by HCG / the product repository; "concept" = illustration, labelled as such. */
  kind: z.enum(["official", "concept"]).default("official"),
  /** Smaller renditions for responsive loading. */
  variants: z.array(z.strictObject({ src: relativeAsset, width: z.number().int().positive() })).default([]),
  /**
   * An AVIF copy exists next to `src` and every variant (same name, `.avif`). Browsers that support
   * AVIF load it; the WebP files remain the fallback.
   */
  avif: z.boolean().default(false),
});

export const ProductArtworkSchema = z.strictObject({
  icon: ArtworkImageSchema.nullable().default(null),
  cover: ArtworkImageSchema.nullable().default(null),
  /** Accent used for the product's branded fallback and highlights (restrained). */
  accent: z.enum(["cyan", "violet", "silver", "mint", "amber"]).default("cyan"),
  /**
   * "app": a full-bleed app icon, shown with the platform's rounded mask.
   * "framed": the artwork draws its own frame, so it is shown whole (no mask, no extra ring).
   */
  iconStyle: z.enum(["app", "framed"]).default("app"),
});

/** Link from a Store product (or one of its editions) to its product page in HCG Repo. */
export const HcgRepoLinkSchema = z.strictObject({
  /** Product key in HCG Repo's config/products.toml; the page is <repo>/products/<key>/. */
  key: kebab,
  editionId: kebab.nullable().default(null),
});

export const ProductSchema = z.strictObject({
  /** Stable identifier. Never change it once published; use `slug` for URLs. */
  id: kebab,
  slug: kebab,
  name: text,
  /** 1–3 characters shown on the generated identification tile. */
  monogram: z.string().regex(/^[A-Z0-9]{1,3}$/),
  summary: z.string().trim().min(10).max(220),
  description: z.array(text).min(1),
  category: z.enum(CATEGORY_IDS),
  tags: z.array(text).default([]),
  developmentStatus: z.enum(DEVELOPMENT_STATUS_IDS),
  developmentNote: text.nullable().default(null),
  platforms: z.array(PlatformEntrySchema).default([]),
  media: z.array(MediaSchema).default([]),
  /** Explicit pointer to the current approved release. "Latest" is never inferred. */
  currentReleaseId: kebab.nullable().default(null),
  registry: z.strictObject({
    status: z.enum(["provisional", "central"]),
    /** Identifier in the HCG ERP product registry, once one exists. */
    centralId: text.nullable().default(null),
    references: z.array(z.strictObject({ system: text, value: text, note: text.optional() })).default([]),
  }),
  /** Public notes about open questions (naming, scope, classification). */
  catalogueNotes: z.array(text).default([]),
  editions: z.array(EditionSchema).default([]),
  hcgRepo: z.array(HcgRepoLinkSchema).default([]),
  /** Features the development repository states are implemented today. */
  currentFeatures: z.array(text).default([]),
  /** Capabilities the repository marks as planned / not yet working. Never shown as available. */
  plannedFeatures: z.array(text).default([]),
  /** Requirements as declared by the build configuration (OS versions, jailbreak layout, …). */
  requirements: z.array(text).default([]),
  artwork: ProductArtworkSchema.default({ icon: null, cover: null, accent: "cyan", iconStyle: "app" }),
  /** Curated storefront collections. Content decision, kept here rather than in components. */
  collections: z.array(z.enum(["featured", "jailbreak", "developer-tools"])).default([]),
  /**
   * The product was merged into another one. It stays in the catalogue so its ID, links and any
   * entitlements keep working, but it is not listed; its page points to the successor.
   */
  supersededBy: kebab.nullable().default(null),
  /** Earlier names, shown on the successor's page so people can find it. */
  formerNames: z.array(text).default([]),
});

export const ArtifactSchema = z
  .strictObject({
    id: kebab,
    platform: z.enum(PLATFORM_IDS),
    architectures: z.array(text).default([]),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f]+$/, "A file name only, without directories."),
    format: z.enum(ARTIFACT_FORMAT_IDS),
    sizeBytes: z.number().int().positive().nullable().default(null),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "SHA-256 must be 64 lowercase hexadecimal characters.")
      .nullable()
      .default(null),
    minimumOs: text.nullable().default(null),
    signing: z
      .strictObject({
        status: z.enum(SIGNING_STATUS_IDS),
        /** Required for "signed" / "notarized": e.g. certificate subject + verification command output reference. */
        evidence: text.nullable().default(null),
      })
      .default({ status: "not-stated", evidence: null }),
    /** Edition this file belongs to, when the product has editions. */
    editionId: kebab.nullable().default(null),
    /**
     * Files are delivered only by the HCG Store server after sign-in and an entitlement check
     * (see docs/ACCESS.md). The public catalogue therefore never contains a download URL.
     */
  })
  .superRefine((a, ctx) => {
    if ((a.signing.status === "signed" || a.signing.status === "notarized") && !a.signing.evidence) {
      ctx.addIssue({ code: "custom", path: ["signing", "evidence"], message: `Signing status "${a.signing.status}" requires evidence.` });
    }
  });

export const ReleaseSchema = z
  .strictObject({
    id: kebab,
    productId: kebab,
    version: z.string().refine(isSemver, "Version must be Semantic Versioning 2.0.0, e.g. 1.2.0 or 0.3.0-beta.1."),
    build: text.nullable().default(null),
    channel: z.enum(RELEASE_CHANNEL_IDS),
    /** "approved" releases may be offered; "withdrawn" ones are kept for history but never offered. */
    status: z.enum(["approved", "withdrawn"]),
    withdrawnReason: text.nullable().default(null),
    /** ISO date (YYYY-MM-DD), only when supplied by HCG. */
    releaseDate: z.iso.date().nullable().default(null),
    releaseNotes: z.array(text).default([]),
    knownLimitations: z.array(text).default([]),
    artifacts: z.array(ArtifactSchema).default([]),
    /**
     * Set only by `npm run releases:sync`: the release was approved in HCG Store (Ship to Store) by a person HCG allows
     * to approve the product, other than its creator. That approval is the release review; this entry is generated
     * from it and must not be edited by hand.
     */
    source: z
      .strictObject({
        kind: z.literal("hcg-store-approval"),
        approvals: z
          .array(
            z.strictObject({
              storeReleaseId: kebab,
              editionId: kebab.nullable(),
              build: text,
              approvedAt: z.iso.datetime(),
              /** Hash of the approval entry in HCG Store's hash-chained publishing audit. */
              approvalAudit: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .min(1),
      })
      .optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === "withdrawn" && !r.withdrawnReason) {
      ctx.addIssue({ code: "custom", path: ["withdrawnReason"], message: "Withdrawn releases need a reason." });
    }
  });

export const ProductsDocumentSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  products: z.array(ProductSchema),
});

export const ReleasesDocumentSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  releases: z.array(ReleaseSchema),
});

export type Media = z.infer<typeof MediaSchema>;
export type PlatformEntry = z.infer<typeof PlatformEntrySchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Edition = z.infer<typeof EditionSchema>;
export type HcgRepoLink = z.infer<typeof HcgRepoLinkSchema>;
export type ArtworkImage = z.infer<typeof ArtworkImageSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
