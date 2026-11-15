# Brand and media assets

## Used in this project

| File | Source | Notes |
|---|---|---|
| `public/brand/hcg-mark-240.webp`, `hcg-mark-480.webp` | `F1r3srp3nt/HCG-Mail` → `Windows-executable-Application/assets/branding/hcg-logo-transparent.png` (commit `f39f98c`) | The chrome and cyan "HCG" mark. HCG Executable Maker's branding notes describe it as the **temporary official HCG logo, as provided by the founder**. Trimmed and resized only; the artwork is unchanged. |
| `public/brand/favicon-32.png`, `apple-touch-icon.png`, `icon-512.png` | Same mark, centred on the obsidian background `#05070c` | **Derived** placeholders. Not an official icon design. |
| `public/brand/hcg-store-hero-800.webp`, `-1200.webp`, `-2000.webp` | Founder-supplied HCG Store hero artwork (2000×667, 3:1), supplied with the storefront redesign request | The **home hero image**. The 2000 px file is the full artwork; the 800 and 1200 px files are resized copies for smaller screens. It is shown **complete**: the frame keeps the 3:1 ratio and uses `object-fit: contain`, so neither the image nor its lettering is cropped at any width. It is marketing artwork (the glass tiles and devices are stylised, not screenshots), so the hero labels it "Illustration". |
| `public/brand/circuit.svg` | Drawn for this site | Faint decorative circuitry tile used behind a few sections only (`.circuit-bg`). Not product imagery. |
| `public/media/products/hcg-executable-maker/*.webp` | `F1r3srp3nt/HCG-Executable-Maker` → `docs/screenshots/01-dashboard.png`, `10-mobile-build-studio.png` (commit `8cfaeee`) | Real screenshots of the running development build, captured under Xvfb by that project. Resized and converted to WebP. They show build 0.1.0; the catalogue says so. |

### Product icons and covers (approved assets reused from each product's own repository)

Each file was resized and converted to WebP only; the artwork is unchanged. The full provenance text is
in `catalogue/products.json` next to each image.

| Product | Files in `public/media/products/<id>/` | Source |
|---|---|---|
| HCG Terminal | `icon-256`, `cover-1200`, `cover-2000` (3:1 header) | App icon and `TerminalHero` header artwork, HCG-Terminal `19b39e6` |
| HCG Nexus | `icon-256` | Standalone app icon set, HCG-Nexus `3136149` |
| HCG Sentinel | `icon-256`, `cover-1200`, `cover-2000` (3:1 header) | App icon and `SentinelHeader` (Dashboard header), HCG-Sentinel `490858c` |
| HCG Mail | `icon-256`, `classic-reading-720/1440`, `account-setup-1000` | App icon and two screenshots rendered by the app's headless UI tests, HCG-Mail `13d93a8` |
| HCG News | `icon-256` | iOS app icon, HCG-News `26fcc42` |
| HCG CardX | `icon-256` | The app's own icon set (development project, commit `e6d5545`; the repository is private and is not named publicly) |
| HCG Clarity | `distil`, `refine`, `presentation` at 720/1440 | Screenshots from the app's automated browser test with synthetic content and the mock AI provider (text marked `[MOCK]`), HCG-Clarity `3a97c07`. Captions say so. |

The header shows the HCG mark followed by the text "STORE" in the site's display font. That is a text
label, not a new logo. **No replacement or official "HCG Store" logo was created.**

The other HCG logo found (`HCG-One/web-hcg-hakmi-capital-group/public/hcg-logo.png`, a serif "HCG /
HAKMI CAPITAL GROUP" lockup) was not used. It suits the corporate brand more than this futuristic
storefront. The founder may prefer it.

## Fallbacks (no invented imagery)

- **Branded product mark** (`ProductMark` in `src/components/ProductArt.tsx`): when a product has no
  approved icon, the store shows its monogram in brushed metal on smoked glass, with the product's accent
  colour. It is decorative (hidden from screen readers; the product name is always next to it) and is not
  presented as an app icon or a screenshot.
- **Cards only show pictures that exist.** A card or product page shows cover art or a real screenshot
  only when the catalogue lists one. Otherwise the card is text-only. No generated tiles, no mock
  interfaces, and no "generated tile" labels in the shopping UI.
- Concept artwork (`media[].kind = "concept"`, or `artwork.cover.kind = "concept"`) is labelled
  "Illustration". Real captures are labelled "Screenshot".
- The old generated SVG tiles (`ProductTile.tsx`) were removed in the redesign.

## Missing assets and facts (checklist for HCG)

Brand
- [ ] Final official HCG logo files (SVG preferred), plus confirmation that the "temporary official" mark is
      approved for the store.
- [ ] A square HCG Store icon / favicon designed for small sizes (the current one is derived from the mark).
- [ ] An Open Graph / social preview image (1200×630). Not emitted until supplied.
- [ ] The READMEs still show the earlier banner (`assets/hcg-store-banner.webp`). Decide whether they should
      use the new hero artwork.

Product icons (1024×1024 PNG or SVG)
- [ ] **HCG Clarity**: no product-specific icon; its desktop build uses the generic HCG logo.
- [ ] **HCG Executable Maker**: the app uses a temporary HCG logo.
- [ ] **HCG ONE: Unleashed**: the repository only has a temporary "DEV BUILD" icon (not used).
- [ ] **HCG LifeOS**: the icon set in the repository is empty.
- [ ] **HCG RePrompter**: none (now part of HCG Clarity; not needed unless the old page should show one).

Screenshots (each with app version and capture source)
- [ ] None yet for **HCG Terminal**, **HCG Nexus**, **HCG Sentinel**, **HCG News**, **HCG ONE: Unleashed**,
      **HCG LifeOS** and **HCG CardX**. These products show their icon or cover art only.
- [ ] **HCG Executable Maker** screenshots show build 0.1.0; the current pre-release is 0.3.0.
- [ ] **HCG Clarity** screenshots use synthetic test content and a mock AI provider; real-content
      captures would be better for a release.

Facts
- [ ] **Prices**: none are set in the catalogue or on the server's offer list for any real product. Every
      real product shows "In development: not for sale"; no Buy Product button is shown.
- [ ] **Central product IDs** from HCG ERP: every product is still `provisional`.
- [ ] **HCG CardX**: its repository has no product description; the store text is based on the app's
      code and should be confirmed.
- [ ] **HCG Terminal Unleashed**: the package is declared for rootless (`iphoneos-arm64`) and rootful
      (`iphoneos-arm`), but HCG Repo only packages the rootless layout. Confirm whether rootful is planned.
- [ ] **HCG RePrompter → HCG Clarity**: founder confirmation that the consolidation is final, and whether
      RePrompter's historical bundle ID should map to Clarity entitlements in HCG ERP.
- [ ] **HCG Mail** macOS: listed as planned only. Confirm whether a macOS build is intended.
- [ ] Release dates, versions and files for every product: none are published, so every product shows
      "No public release supplied".

To add product art, put WebP files in `public/media/products/<id>/` and reference them from the product's
`artwork` (icon/cover) or `media` (screenshots) in `catalogue/products.json`; `npm run validate:catalogue`
checks that the files exist. To replace the hero banner, overwrite the three `hcg-store-hero-*.webp`
files (keep the 3:1 ratio, or update `SIZES`/`HEIGHT` in `src/components/HeroBanner.tsx`).
