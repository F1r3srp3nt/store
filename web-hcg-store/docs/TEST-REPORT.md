# Test report: first working milestone

Run on 3 November 2026 in a Linux container (Node 22.23.4, npm 10.9.9, Chromium via Playwright 1.63.0).

## Results

| Check | Command | Result |
|---|---|---|
| Catalogue validation and unique IDs | `npm run validate:catalogue` | ✔ 14 products, 0 releases; fixture catalogue also valid |
| Type checking | `npm run typecheck` | ✔ no errors |
| Unit and component tests | `npm test` | ✔ **111 passed** in 10 files |
| Production build | `npm run build` | ✔ JS 438.6 kB (134.1 kB gzip), CSS 38.8 kB (8.5 kB gzip) |
| Bundle secret scan | part of `npm run build` | ✔ 7 text files, 13 patterns, no findings |
| End-to-end (Chromium, against `vite preview` with production headers) | `npm run test:e2e` | ✔ **33 passed**, 1 skipped (opt-in screenshot capture) |
| Dependency audit | `npm audit` | ✔ 0 vulnerabilities |

An e2e run exposed a real defect: the browse search box lost keystrokes during fast typing. It was fixed
and the test was repeated 10 times without failure.

## Coverage of the acceptance list

| Requirement | Where verified |
|---|---|
| Type checking and production build | `tsc -b`, `vite build` |
| Catalogue validation and unique IDs | `src/domain/catalogue.test.ts`: duplicates, broken references, withdrawn current releases, unknown fields, bad versions, checksums, signing without evidence, deceptive links, guessed architectures |
| Search and filters | `src/domain/query.test.ts` (text, accents, all-terms, platform, category, availability, status, combined, URL round-trip, hostile params); `src/app.test.tsx`; e2e keyboard filter test |
| Product and release routes, including direct navigation | e2e `direct load …` for 9 routes (home, browse, 2 products, release history, getting started, account, filtered browse, 404). All return 200 with the right `<h1>` and no console or CSP errors |
| Missing-release and missing-image states | UI tests and e2e (fixture `fixture-nebula-pad`; images blocked by route abort on a real product) |
| Dropbox conversion preserving parameters | `src/downloads/dropbox.test.ts`; e2e checks the actual navigation request (`dl=1`, `rlkey`, `st` preserved; `raw` removed) |
| Rejection of unsupported or deceptive URLs | 30 rejection cases: protocols, credentials, `@` tricks, ports, lookalike, trailing-dot and IDN-homograph hosts, backslashes, folders, missing `rlkey`, over-long |
| Keyboard navigation | e2e: skip link, focus to `<main>` after navigation, reaching and opening a product card by Tab/Enter, mobile menu Enter/Escape, filters by keyboard, header search |
| Reduced motion | e2e: orbital animation `orbit` normally, `none` under `prefers-reduced-motion`; transitions ≈ 0 |
| Responsive 390 / 768 / 1024 / 1440 px | e2e: no horizontal overflow on 6 pages at **320, 390, 507, 768, 1024, 1440** px (320 and 507 approximate narrow tablet multitasking), plus fixture release pages at 390 px |
| No fabricated availability, account state or statistics | UI tests and e2e scan every page for download/install/user counts, ratings, reviews, prices, purchase or "signed in" wording, and for Dropbox links in the real catalogue. Catalogue tests assert 0 releases, no URLs, no `confirmed` platforms, no central IDs |
| No simulated authentication | `hcg-connect.test.ts`: unconfigured, partial and full configuration → no `fetch`, sign-in refused. The Account page shows "HCG Connect not configured" and a disabled button |
| No secrets in the bundle | `scripts/check-bundle-secrets.mjs` on `dist/` (and its own tests); the build refuses credential-like `VITE_` names (checked manually) |
| Indexing safety | e2e: `X-Robots-Tag`, `<meta name="robots" content="noindex">`, no canonical, `robots.txt` disallow, no future-domain references in HTML. Manually checked that the build refuses the future domain outside production, and that an explicit production build (scratch output only) emits `Allow`, a 31-URL sitemap and HSTS |
| Fixture safety | The build refuses fixture data for production or without the fixture banner |

## Screenshots

`docs/screenshots/` (captured with `npm run screenshots` from the production build):

| File | Content |
|---|---|
| `home-1440.png` | Home page, full height |
| `browse-1440.png`, `browse-768.png` | Browse with filters (768 px with macOS filter) |
| `product-executable-maker-1440.png` | Product with real screenshots and "No public release supplied" |
| `product-mail-390.png`, `home-390.png` | Phone layouts |
| `getting-started-1024.png` | Installation guidance |
| `account-1440.png` | Account & Connections ("HCG Connect not configured") |
| `fixture-release-panel-1440.png`, `fixture-release-history-390.png` | **Test fixture data** (labelled banner) showing the release panel, downloads and history |

## Not run / limitations

- **No real artifact URL was supplied**, so `npm run verify:artifact` was only exercised on rejection
  paths. No real Dropbox download was tested. The e2e download test intercepts the navigation locally and
  never contacts Dropbox.
- Browsers other than Chromium (Safari/WebKit, Firefox) and real phones and tablets were not tested.
  Responsive checks used Chromium viewports.
- No screen-reader testing (VoiceOver/NVDA) and no automated axe audit were run. Semantics were checked
  through role-based queries in the tests.
- No Lighthouse or real-network performance measurement.
- No deployment to a preview host. Hosting configurations (`_headers`, `_redirects`, `vercel.json`,
  nginx example) were reviewed but not exercised on those hosts.
- HCG ERP and HCG Connect integrations were tested only against mocks, because no endpoints or contracts
  exist yet.
