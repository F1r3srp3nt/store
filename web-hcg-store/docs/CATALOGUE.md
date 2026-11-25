# Catalogue management (first version)

The catalogue lives in two files:

| File | Contents |
|---|---|
| `catalogue/products.json` | Product registry entries (identity, description, status, platforms, media) |
| `catalogue/releases.json` | Approved release metadata and download artifacts |

These files are **provisional seed and configuration data**. They are not a second permanent product
authority. HCG ERP / Executive Control Center remains the source of truth for the product registry,
approved releases, organisations, licences and App Access. When the ERP registry contract exists, switch
to the `hcg-erp` provider (see [HCG-INTEGRATION.md](HCG-INTEGRATION.md)) and keep the IDs listed here.

There is deliberately **no admin page**. A web form that claimed to "save centrally" would be dishonest
until a governed ERP endpoint exists. Changes go through Git review.

After every edit:

```bash
npm run validate:catalogue
npm test
```

The production build (`npm run build`) also refuses to build an invalid catalogue.

---

## Concepts

| Field | Meaning |
|---|---|
| `id` | **Stable** identifier, lowercase kebab-case. Never change it after publication; other systems may reference it. |
| `slug` | URL segment (`/apps/<slug>`). Normally equal to `id`. |
| `registry.status` | `provisional` until HCG ERP assigns an ID; then `central` with `registry.centralId` set. |
| `registry.references` | Cross-references to other HCG systems (e.g. LifeOS realms, which are not product IDs). **Shipped publicly:** never list private repositories or internal URLs. |
| `developmentStatus` | Development progress: `in-development`, `planning`, `testing`, `maintained`, `paused` or `unknown`. **Independent of releases.** |
| `platforms[].support` | `confirmed` (an approved release supports it), `in-development` or `planned`. Architectures and minimum OS may be stated **only** for `confirmed`. |
| `media[]` | `screenshot` (a real capture of the software, labelled "Screenshot") or `concept` (artwork, labelled "Illustration"). `provenance` is required. Never put invented interface imagery here. |
| `artwork.icon` / `artwork.cover` | The product's own approved icon and cover/header artwork (`src`, `width`, `height`, `alt`, `provenance`, `kind` = `official` or `concept`, optional resized `variants`). `null` when none exists: the store then shows a branded monogram, never a fake icon. Files must exist under `public/` (checked by `npm run validate:catalogue`). |
| `editions[].centralEditionKey` | The key HCG's central licensing uses for this edition (decision D2): a module-scope licence `edition:<key>`. Null = not mapped; HCG Store then never checks that edition centrally and never sells it. Set only for products with a confirmed `registry.centralId`, unique per product. See [MAIN-SITE-INTEGRATION.md](MAIN-SITE-INTEGRATION.md). |
| `artwork.icon.avif` / `artwork.cover.avif` | `true` when an AVIF copy sits next to the WebP file and each variant (same name, `.avif`). Browsers that support AVIF use it; WebP is the fallback. |
| `artwork.iconStyle` | `app` (full-bleed app icon, shown with a rounded mask) or `framed` (the artwork draws its own frame and is shown whole). |
| `artwork.accent` | `cyan`, `violet`, `silver`, `mint` or `amber`: the accent edge used for the product's mark and cards. |
| `currentFeatures[]` | Features present in the current development build, as the product's repository describes them. Shown under "Available in the current build". |
| `plannedFeatures[]` | Features that are planned but not built. Shown separately under "Planned (not available yet)". Never mix the two. |
| `requirements[]` | Plain-language requirements (minimum OS, hardware, jailbreak layout, accounts). |
| `collections[]` | Curated homepage sections: `featured`, `jailbreak` (the Jailbreak & Unleashed band; the product must also have `hcgRepo` links) and `developer-tools`. Content changes here, not in components. |
| `supersededBy` | ID of the product this one has been merged into, or `null`. A superseded product is hidden from listings, search and filters but **keeps its page, ID, links and entitlements**; the page points to the successor. The successor must exist and must not itself be superseded, and a superseded product has no collections. |
| `formerNames[]` | Earlier names of this product. Shown as "Formerly …" and included in search. |
| `currentReleaseId` | Explicit pointer to the current approved release. `null` shows "No public release supplied". |
| `catalogueNotes` | Public notes about open questions (naming, scope, classification). |

Everything in these files is bundled into the public website. Do not put anything private in them.

### Merges

- **HCG RePrompter** and **Distil** are now part of **HCG Clarity** (`hcg-clarity`, `formerNames`:
  "HCG RePrompter", "Distil"). The `hcg-reprompter` entry stays, with `supersededBy: "hcg-clarity"`, so
  `/apps/hcg-reprompter`, its ID, HCG Repo mapping (none) and any future entitlements keep working. Its
  historical bundle identifier stays recorded on that entry.

### ID reconciliation performed

No HCG ERP product registry was reachable while this catalogue was created. IDs were assigned
provisionally from the product names, and cross-checked against what was available:

- **HCG LifeOS** realm keys (`hcg.mail`, `hcg.one`, `hcg.devtools`, `hcg.lifeos`) are recorded as references,
  not used as IDs, because they belong to LifeOS. LifeOS uses `hcg.one` for both "HCG ONE" and
  "HCG ONE: UNLEASHED". That needs a central decision.
- The HCG ONE web app's own product list (`trading-analytics`, `asset-index`, `signature-studios`,
  `trader-mission`) covers different products. None of its IDs collide with this catalogue.
- **HCG Studio** (`hcg-studio`) is kept separate from *Hakmi Signature Studios*.
- **HCG Development Tools** is the category `developer-tools`, not a product.
- **HCG Store** (this site), **HCG AppStore** (planned native app) and **Unimatch** are not listed.

---

## Catalogue v2 fields

Kept separate on purpose; none implies another:
- **Edition tier** (`tier`): Standard, Professional, Founder Beta, Developer, Unleashed, or `null` when HCG has not said.
- **Pricing model** (`pricingModel`): free, paid, subscription or `not-set`. A pricing model is not a price; prices exist
  only as approved server offers (`server/data/offers.json`).
- **Access** (`access`): none, HCG account sign-in, HCG licence, or `unknown`. HCG's `/check` still decides every download.
- **Distribution channel** (`channel`), **development status**, and **release availability** ("Coming soon" until a
  release is approved and named in `currentReleaseId`).

Product fields: `visibility` (`listed` or `draft`), `family`, `trailers` (self-hosted, with `kind` recording/concept and
provenance), `hardwareRequirements`, `documentation` and `support` (public https links only), `relatedProducts`
(catalogue IDs; no drafts, no self, no duplicates). Artifacts may carry `sourceCommit`, `buildProvider` and `toolchain`
(generated from Store approvals).

**Drafts** are products HCG has named but not described (HCG ADS, System Tester, Signal Contractor, LifeOS Companion,
Representation). They hold a name and nothing invented: status "not stated", no platforms, editions, features, media,
releases, collections or HCG Repo links. They are validated but never listed, searched, linked or given a page, and are
left out of My HCG apps. Publish one by filling in HCG's facts and setting `visibility: "listed"`.

## Adding a product

1. Append an object to `products` in `catalogue/products.json`:

   ```json
   {
     "id": "hcg-example",
     "slug": "hcg-example",
     "name": "HCG Example",
     "monogram": "EX",
     "summary": "One or two sentences, 10–220 characters, stating only what is true today.",
     "description": ["Paragraph one.", "Paragraph two."],
     "category": "productivity",
     "tags": ["keyword"],
     "developmentStatus": "planning",
     "developmentNote": null,
     "platforms": [],
     "media": [],
     "currentReleaseId": null,
     "registry": { "status": "provisional", "centralId": null, "references": [] },
     "catalogueNotes": []
   }
   ```

2. Allowed values for `category`, `developmentStatus` and `platforms[].platform` are listed in
   `src/domain/taxonomy.ts`. Unknown fields are rejected (this catches typos).
3. Leave `platforms` empty if support is unknown. Do not guess.
4. For screenshots: put WebP files in `public/media/products/<id>/`, add `width`/`height`, a descriptive
   `alt`, a `caption` and a `provenance` (repository, path, commit, build). Optional `variants` give
   smaller sizes for `srcset`. Never add mock-ups as `screenshot`.
5. Run `npm run validate:catalogue`.

## Adding a release

1. Append to `releases` in `catalogue/releases.json`:

   ```json
   {
     "id": "hcg-example-1-0-0",
     "productId": "hcg-example",
     "version": "1.0.0",
     "build": "100",
     "channel": "stable",
     "status": "approved",
     "withdrawnReason": null,
     "releaseDate": "2026-11-15",
     "releaseNotes": ["What changed."],
     "knownLimitations": ["What does not work yet."],
     "artifacts": [
       {
         "id": "win-x64",
         "platform": "windows",
         "architectures": ["x64"],
         "fileName": "HCG-Example-1.0.0-win-x64.zip",
         "format": "zip",
         "sizeBytes": 48234496,
         "sha256": "<64 lowercase hex characters>",
         "minimumOs": null,
         "signing": { "status": "unsigned", "evidence": null },
         "editionId": null
       }
     ]
   }
   ```

2. Set the product's `currentReleaseId` to the release `id` **only when HCG approves it as current**.
3. Rules enforced by the validator:
   - `version` must be Semantic Versioning 2.0.0 (`1.2.0`, `0.3.0-beta.1`). Versions must be unique per product.
   - `releaseDate` is optional. Leave it `null` unless HCG supplied it.
   - `signing.status` `signed` or `notarized` **requires** `evidence`, e.g. the certificate subject and a
     reference to `codesign --verify` / `spctl -a` / `Get-AuthenticodeSignature` output. The site still
     shows it as "stated by HCG". It never says "verified" or "safe".
   - `sha256` must be the real checksum of the exact file (64 lowercase hex characters).
   - Artifacts **never** carry a download URL. The schema rejects `download` and `url`, because every
     file is delivered only by the HCG Store server after sign-in and an entitlement check (see
     [ACCESS.md](ACCESS.md)). Products with several editions must set `editionId` on every artifact.
   - A withdrawn release (`"status": "withdrawn"`) needs `withdrawnReason`. It stays in history, is
     never delivered, and cannot be current.
4. To supersede a release, add the new one and move `currentReleaseId`. The old one is then labelled
   "Previous release" in history. Do not delete old releases.

## Making the first release deliverable (only after launch approval)

1. Add the release to `catalogue/releases.json` as above, with the exact file name, size and SHA-256.
   Set `currentReleaseId` only when HCG approves it as current.
2. Put the file in the server's **private** storage (`HCG_STORE_ARTIFACT_STORAGE_DIR`), never in
   `public/`, `dist/`, a public GitHub release or a shared link.
3. Add it to `server/data/artifacts.json` with `productId`, `releaseId`, `catalogueArtifactId`,
   `editionId`, `fileName`, `sha256`, `storageKey` and `deliveryApproved: true`, set only on HCG's
   approval. The server refuses a mismatch with the catalogue.
4. To sell it, add an offer to `server/data/offers.json` with a price supplied by HCG and the product's
   confirmed central ID (see [PAYMENTS.md](PAYMENTS.md)).
5. Downloads remain off until the launch conditions in [ACCESS.md](ACCESS.md) are met and the founder
   approves.

## Editions and HCG Repo links

- `editions[]`: separately built editions or platform builds as declared by the development repository:
  name, platforms, intended `channel`, stated `status`, `identifiers` (bundle IDs and Debian package
  IDs) and declared package `layouts`. A `jailbreak-package` edition must declare its package ID.
- `hcgRepo[]`: explicit links to HCG Repo product pages (`<repo>/products/<key>/`), optionally per
  edition. Keys are unique. Keep them in step with HCG Repo's `config/products.toml` and run
  `npm run check:repo-mapping -- <HCG-repo checkout>`.

The test fixture in `tests/fixtures/catalogue-demo/` is labelled fake data and is never built for
production.
