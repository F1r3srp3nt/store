import { z } from "zod";
import { DOWNLOAD_PROVIDERS, DOWNLOAD_PROVIDER_IDS } from "../downloads/providers";
import {
  ARTIFACT_FORMAT_IDS,
  CATEGORY_IDS,
  DEVELOPMENT_STATUS_IDS,
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
    download: z.strictObject({ provider: z.enum(DOWNLOAD_PROVIDER_IDS), url: z.string() }).nullable().default(null),
  })
  .superRefine((a, ctx) => {
    if ((a.signing.status === "signed" || a.signing.status === "notarized") && !a.signing.evidence) {
      ctx.addIssue({ code: "custom", path: ["signing", "evidence"], message: `Signing status "${a.signing.status}" requires evidence.` });
    }
    if (a.download) {
      const r = DOWNLOAD_PROVIDERS[a.download.provider].resolve(a.download.url);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["download", "url"], message: r.reason });
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
export type Release = z.infer<typeof ReleaseSchema>;
