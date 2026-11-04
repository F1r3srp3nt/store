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
| `registry.references` | Cross-references to other HCG systems (e.g. LifeOS realm keys). **Shipped publicly:** never list private repositories or internal URLs. |
| `developmentStatus` | Development progress: `in-development`, `planning`, `testing`, `maintained`, `paused` or `unknown`. **Independent of releases.** |
| `platforms[].support` | `confirmed` (an approved release supports it), `in-development` or `planned`. Architectures and minimum OS may be stated **only** for `confirmed`. |
| `media[]` | `screenshot` (a real capture of the software) or `concept` (artwork, shown as "Concept artwork, not the working app"). `provenance` is required. |
| `currentReleaseId` | Explicit pointer to the current approved release. `null` shows "No public release supplied". |
| `catalogueNotes` | Public notes about open questions (naming, scope, classification). |

Everything in these files is bundled into the public website. Do not put anything private in them.

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
         "download": { "provider": "dropbox", "url": "<real Dropbox shared-file link>" }
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
   - `download.url` must be a valid Dropbox shared-file link (see [DOWNLOADS.md](DOWNLOADS.md)).
   - A withdrawn release (`"status": "withdrawn"`) needs `withdrawnReason`. It stays in history, its
     downloads are disabled, and it cannot be current.
4. To supersede a release, add the new one and move `currentReleaseId`. The old one is then labelled
   "Previous release" in history. Do not delete old releases.

## Adding the first real Dropbox-hosted release

1. **Upload** the final, approved file to Dropbox, e.g. `HCG-Mail-0.1.0-win-x64.zip`.
2. **Share** it: *Share → Copy link* (anyone with the link can view). You get a link like
   `https://www.dropbox.com/scl/fi/<id>/HCG-Mail-0.1.0-win-x64.zip?rlkey=<key>&dl=0`.
   Keep the **whole** link. `rlkey` is required.
3. **Checksum** the local file:
   - macOS: `shasum -a 256 HCG-Mail-0.1.0-win-x64.zip`
   - Windows PowerShell: `Get-FileHash -Algorithm SHA256 .\HCG-Mail-0.1.0-win-x64.zip`
   - Linux: `sha256sum HCG-Mail-0.1.0-win-x64.zip`
4. **Verify the link** from this project (this downloads the file to hash it, not into the browser):

   ```bash
   npm run verify:artifact -- "<the Dropbox link>" --name HCG-Mail-0.1.0-win-x64.zip --sha256 <checksum>
   ```

   It reports the HTTP status, final host, content type, server file name and size. It fails on HTML pages
   (private, expired or rate-limited links), on unexpected hosts and on checksum mismatch. It checks the
   **file response only**. It does not test the application.
5. **Add the release** to `catalogue/releases.json` as above. Use the size in bytes and the checksum.
   State signing only with evidence.
6. Set the product's `currentReleaseId`. Update `platforms` to `confirmed` with architectures and minimum
   OS **only** if they were verified for this build.
7. Run `npm run check`, then open `npm run preview` → the product page. Confirm the release panel and
   the download button, which goes to `www.dropbox.com/...&dl=1`.
8. Commit the change on a branch for founder review. Publishing remains a founder decision.

Never commit placeholder or example Dropbox links to `catalogue/`. The test fixture in
`tests/fixtures/catalogue-demo/` uses obviously fake `FIXTURE…` IDs and is never built for production.
