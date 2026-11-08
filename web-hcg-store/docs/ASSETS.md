# Brand and media assets

## Used in this project

| File | Source | Notes |
|---|---|---|
| `public/brand/hcg-mark-240.webp`, `hcg-mark-480.webp` | `F1r3srp3nt/HCG-Mail` → `Windows-executable-Application/assets/branding/hcg-logo-transparent.png` (commit `f39f98c`) | The chrome and cyan "HCG" mark. HCG Executable Maker's branding notes describe it as the **temporary official HCG logo, as provided by the founder**. Trimmed and resized only; the artwork is unchanged. |
| `public/brand/favicon-32.png`, `apple-touch-icon.png`, `icon-512.png` | Same mark, centred on the obsidian background `#05070c` | **Derived** placeholders. Not an official icon design. |
| `public/media/products/hcg-executable-maker/*.webp` | `F1r3srp3nt/HCG-Executable-Maker` → `docs/screenshots/01-dashboard.png`, `10-mobile-build-studio.png` (commit `8cfaeee`) | Real screenshots of the running development build, captured under Xvfb by that project. Resized and converted to WebP. Captions state the development build. |

The header shows the HCG mark followed by the text "STORE" in the site's display font. That is a text
label, not a new logo. **No replacement or official "HCG Store" logo was created.**

The other HCG logo found (`HCG-One/web-hcg-hakmi-capital-group/public/hcg-logo.png`, a serif "HCG /
HAKMI CAPITAL GROUP" lockup) was not used. It suits the corporate brand more than this futuristic
storefront. The founder may prefer it.

## Generated artwork (clearly labelled)

- **Product identification tiles** (`src/components/ProductTile.tsx`): abstract SVG with the product
  monogram. Shown with a "Generated tile" label, and announced to screen readers as "generated artwork,
  not a screenshot". They are not product icons.
- **Home hero orbital motif** (`src/components/OrbitalHero.tsx`): decorative SVG. It does not depict any
  product.

## Missing assets (needed from HCG)

1. Final official HCG logo files (SVG preferred), plus confirmation that the "temporary official" mark is
   approved for the store.
2. A square HCG Store icon / favicon designed for small sizes.
3. An Open Graph / social preview image (1200×630). Not emitted until supplied.
4. Official app icons for each product (1024×1024 PNG or SVG).
5. Real screenshots for products other than HCG Executable Maker, each with the app version and capture
   source. Until then, products show generated tiles.

To add product screenshots, see [CATALOGUE.md](CATALOGUE.md#adding-a-product). To replace the mark, overwrite
the files in `public/brand/` at the same pixel sizes, or update `src/components/Layout.tsx` and
`OrbitalHero.tsx`.
