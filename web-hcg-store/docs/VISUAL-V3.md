# HCG Store v3: Futuristic Visual Evolution

A storefront visual and experience upgrade. Catalogue data, HCG Connect sign-in, My Library, Release Manager, Ship to
Store, payments, protected downloads, licensing and the Fly.io configuration are unchanged; no server file changed.

Screenshots: [`docs/screenshots/v3/`](screenshots/v3/) (real captures of the production build, static host).

## 1. Themes (`src/theme/`, `src/styles/tokens.css`, `src/styles/themes.css`)

One set of design tokens; a theme redefines only channel tokens (`--accent-rgb`, `--accent-2-rgb`, `--hairline-rgb`,
`--surface-rgb`, `--deep-rgb`, …), surfaces, text, metal gradients and atmosphere. Every component reads those tokens:
about 120 hard-coded colours were converted, so backgrounds, cards, borders, navigation, buttons, illumination,
typography accents and decoration all follow the theme. Nothing is duplicated per theme.

| Theme | Palette |
| --- | --- |
| HCG Sovereign (default) | obsidian, titanium, electric cyan, sapphire |
| Cyberpunk | neon violet, magenta, electric blue, night-city light |
| Crimson Frontier | black, crimson, industrial steel (after HCG Offensive Frontier) |
| Founder Edition | obsidian, polished gold, titanium |
| Quantum Frost | white, silver, ice blue, glass (light theme; the chrome HCG mark sits on a titanium plate) |
| Event Horizon | deep navy, cosmic violet, orbital light |

- **Name:** the theme requested as "Cyberpunk 2077" ships as **Cyberpunk** (id `cyberpunk`). "Cyberpunk 2077" is a
  third-party game title and trademark, so the public Store doesn't use it. Only original HCG styling is used: no game
  assets. Renaming is a one-line change in `theme.ts` if HCG decides otherwise.
- **Choosing:** any visitor, without signing in: the palette button in the header, or the theme section of the mobile
  menu. Stored in this browser only (`hcg-store.theme`, `hcg-store.effects`). Storage that is unavailable, blocked or
  tampered with falls back to Sovereign. `public/theme-boot.js` applies the choice before the first paint; the CSP
  allows only same-origin scripts, so it is a file, not inline.
- **Future sync:** `RemotePreferenceSync` in `theme.ts` is the contract for keeping the choice with an HCG Connect
  account (`GET/PUT /api/v1/preferences`, session-bound, non-sensitive). Not implemented: signing in changes nothing about
  the theme today.
- **Contrast:** `src/theme/theme.test.ts` computes WCAG contrast for every theme on its page and panel colours. Body
  text is at least 7:1; muted text, faint text and the accent are at least 4.5:1.

## 2. Background engine (`src/theme/AmbientBackground.tsx`, `src/styles/effects.css`)

Atmospheric gradients, a metallic sheen, circuitry, a holographic grid, the faded HCG mark (no crown asset exists, so
the official chrome mark is used), orbital geometry, digital particles and cyan energy lines. It is fixed behind the
page, `aria-hidden`, takes no pointer events and is CSS-only: no canvas, no WebGL, no video.

**Performance rule:** the large, full-screen layers are static. Only small layers move: the energy lines, Sentinel's
header light, the hero symbols and the hero sheen. Phones get fewer layers.

## 3. Homepage (`src/pages/HomePage.tsx`, `catalogue/storefront.json`)

Sections, in the order `storefront.json` sets:

| Section | Source | Shown when |
| --- | --- | --- |
| Cinematic hero | official HCG Store banner (whole, uncropped, labelled) with layers, subtle parallax, metallic sheen, holographic product symbols, spotlight rotation | always |
| New releases | products whose explicit `currentReleaseId` is approved | at least one: **hidden today** |
| Recently updated | approved releases by date | at least one: **hidden today** |
| Featured products | `storefront.json` `featured` (or the catalogue's `featured` collection) | any |
| Browse by category | category grid with real counts, platforms, search | any |
| Upcoming technology | in development, testing or planning, with no release | any |
| HCG ecosystem explorer | stated integrations (below) | at least two nodes |
| Explore by area | developer tools, security instruments, infrastructure, productivity (tabs; empty areas get no tab) | any |
| Jailbreak & Unleashed | Unleashed tiers or jailbreak-package editions | any |
| HCG News announcements | HCG News, through the contract below | **hidden today** |
| HCG ADS campaigns | central HCG ADS, through the contract below | **hidden today** |
| All products, access guidance | catalogue | always |

- **Data rules:** no statistics, reviews, downloads or fabricated products. A release, version or price appears only
  when the data has one. Draft products are never shown.
- **Administrators:** they configure the hero spotlight, featured products and section order in
  `catalogue/storefront.json`, reviewed by pull request like the catalogue. `npm run validate:catalogue` refuses IDs that
  aren't listed products (drafts, merged or unknown).
- **New category:** HCG Server moved to a new **Infrastructure & Servers** category.

## 4. Product cards and pages

- **Cards** (`ProductCard.tsx`) come in four variants: `feature` (expanded), `card`, `compact` and `row`. They have:
  - a holographic gradient border and illumination in the product's own accent;
  - a metallic top edge;
  - the official icon and banner;
  - platform and edition indicators;
  - the real status, plus the release version and date only when an approved release exists.

  Hover effects apply on desktop; on touch screens a press gives brief feedback. Long lists use shelves that scroll
  sideways on phones instead of tall stacks.
- **Product pages** have a decorative `atmosphere` in the product's `artwork`. It is presentation only, behind the
  content, and checkout and download controls are unchanged:

  | Atmosphere | Product |
  | --- | --- |
  | infrastructure | HCG Server |
  | security | HCG Sentinel |
  | fabrication | HCG Executable Maker |
  | RPG | HCG LifeOS |
  | terminal | HCG Terminal |
  | media | HCG News |
  | markets | HCG ONE: Unleashed |
  | signal | HCG Nexus |
  | crimson | prepared for HCG Offensive Frontier, which isn't in the catalogue yet |

## 5. Navigation (`src/components/Layout.tsx`)

- **Desktop:** Discover, Products, Categories and Platforms (menus with counts), New releases, HCG Repo, Account,
  search, the theme selector, and My Library or sign-in.
- **Phones:** a full-height sheet with:
  - full-width search ("Search HCG Store", no truncation, 16px text so iOS doesn't zoom);
  - six tiles: Discover, Products, New releases, HCG Repo, My Library, Account;
  - wrapping category and platform chips (no clipping);
  - the theme choices.

  It respects safe areas and the page doesn't scroll behind it.
- **Cart:** there is none, because the Store has no cart (checkout is per offer).

## 6. Ecosystem explorer (`src/domain/ecosystem.ts`, `EcosystemExplorer.tsx`)

- **Nodes:** listed products, plus HCG Connect and HCG Repo when a product states an integration with them.
- **Edges:** only from catalogue facts: the new `integrations` field, `relatedProducts`, and families. Merged products
  appear inside their successor.
- **Status:** "available" (solid) is allowed only when both sides have an approved current release, which
  `validateCatalogue` enforces. Everything else is "planned" (dashed).
- **Today:** every integration is planned. The integrations recorded are the ones the products' own data states:
  - Sentinel → HCG Server;
  - HCG Server → Executable Maker;
  - Nexus → Terminal, News and HCG Repo;
  - Terminal → HCG Repo;
  - LifeOS, ONE: Unleashed and Clarity → HCG Connect.
- **Interface:** a list of buttons with a details panel; the constellation mirrors it visually.

## 7. HCG ADS and HCG News (`src/storefront/placements.ts`)

- **Inactive:** HCG Store runs no advertising engine. A slot shows only creatives the central HCG ADS service approved,
  that are running now, and whose links are safe (site paths or https; no `javascript:`, `data:` or `//`).
- **Labels:** paid placements are labelled "Sponsored"; HCG's own promotions are labelled "HCG". With nothing
  eligible, the section isn't rendered.
- **Off until:** `VITE_STORE_PLACEMENTS=enabled`. Nothing is requested until then.
- **Endpoints expected:** same-origin `GET /api/v1/placements?slot=` and `GET /api/v1/announcements`, so the CSP stays
  `'self'`.

## 8. HCG Representation (`src/storefront/representation.ts`)

- **What it can supply:** a versioned manifest (`hcg.representation.manifest/1`) of product icons, banners, logos,
  backgrounds, promotional images, theme definitions and design tokens.
- **Limits:** entries must be same-origin paths; local files always remain the fallback.
- **Inactive:** until `VITE_HCG_REPRESENTATION_MANIFEST` is set.

## 9. Motion and accessibility

- **Effects:** Sentinel's header light, card illumination, animated gradient borders on hover, energy lines, a
  cross-fade when switching themes, scroll entrances, restrained parallax (fine pointers only), and a loading skeleton.
- **Off switches:** `prefers-reduced-motion` and the **Decorative effects** switch stop all of them. The spotlight then
  doesn't rotate; it always has a pause button and direct buttons (WCAG 2.2.2).
- **Tests:**
  - `e2e/visual-v3.spec.ts` checks that no animation runs under reduced motion or with effects off;
  - that the choice persists across reloads;
  - that there's no horizontal overflow at 320, 375, 390, 430, 768, 1024 and 1440px on seven pages;
  - and that header touch targets are at least 40px.

## 10. Performance (measured, headless Chromium, median of 3)

| Profile | Build | LCP | CLS | idle main thread | scroll main thread | scroll fps |
| --- | --- | --- | --- | --- | --- | --- |
| Phone 390, 4× CPU | before (main) | 736 ms | 0.923 | 8.1 % | 10.3 % | 60 |
| | v3, effects on | 612 ms | **0.044** | 11.3 % | 20.1 % | 56 |
| | v3, effects off | 544 ms | **0.044** | 2.8 % | 6.7 % | 60 |
| Desktop 1440 | before (main) | 232 ms | 0.950 | 2.1 % | 2.0 % | 60 |
| | v3, effects on | 412 ms | **0.026** | 3.7 % | 6.1 % | 56 |
| | v3, effects off | 432 ms | **0.026** | 0.9 % | 1.8 % | 60 |

- **Bundle:** +10.9 KB gzip JavaScript and +7.3 KB gzip CSS.
- **Idle:** 60 fps in every case.
- **First attempt rejected:** continuously animating the full-screen grid, particles and orbits, plus a spinning
  conic border, ran at about 25 fps on desktop software rendering. Those layers are now static, the header lost its
  backdrop blur, and the grid is flat.
- **Layout shift:** the pre-existing layout shift of about 0.92 (the footer jumping when the catalogue rendered) is
  fixed by reserving the main area's height and rendering the navigation menus from the start.

## 11. Before and after (mobile, 390px)

- `before-after-first-screen-390.webp` and `before-after-home-mobile-390.webp` compare the live site (835ac1a) with
  v3.
- **Fixed:**
  - the truncated "Search products, features…" placeholder;
  - category chips clipped at the right edge;
  - a featured card with an empty dark cover;
  - a sparse first screen.
- **Height:** v3 is 7,428px against 5,443px, carrying hero, spotlight, category grid, upcoming shelf, ecosystem
  explorer and area tabs. Shelves scroll sideways instead of stacking.
- **Comparison baseline:** the brief mentioned a supplied screenshot, but none came with it, so the comparison is
  against the live page.

## 12. Compatibility

- **Unchanged:** HCG Payments' development branch (`claude/wonderful-wright-gh10pc`) changes `src/account/api.ts`
  and `src/pages/CheckoutReturnPage.tsx`; v3 changes neither, nor any server file, `fly.toml` or the Dockerfile.
- **Catalogue additions:** all are additive with defaults:
  - `artwork.atmosphere`;
  - `artwork.accent: "crimson"`;
  - `integrations`;
  - the `infrastructure` category;
  - `storefront.json`.
