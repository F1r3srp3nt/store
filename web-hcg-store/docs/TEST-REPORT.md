# Test report: accounts, ownership and protected delivery

Run on 15 November 2026 in a Linux container (Node 22.23.4, npm 10.9.9, Chromium via Playwright
1.63.0). Nothing ran against live HCG systems. HCG Connect was replaced by a **mock provider that uses
the live provider's protocol** (`server/test/mock-hcg-connect.ts`), and payments by the **TEST
provider**.

## Results

| Check | Command | Result |
|---|---|---|
| Catalogue validation | `npm run validate:catalogue` | ✔ 11 products, 0 releases; fixture catalogue valid |
| Type checking (app and server) | `npm run typecheck` | ✔ no errors |
| Unit, component and **server acceptance** tests | `npm test` | ✔ **124 passed** in 10 files (40 of them server tests) |
| Production build, bundle secret scan, server bundle | `npm run build` | ✔ secret scan: 7 files, 13 patterns, no findings |
| End-to-end in Chromium (static previews and the TEST-mode Store server) | `npm run test:e2e` | ✔ **36 passed**, run **3 times** without a failure (2 opt-in screenshot tests skipped) |
| Store ⇄ HCG Repo mapping, both directions | `npm run check:repo-mapping -- ../HCG-repo` | ✔ 3 HCG Repo products, 3 Store links, package IDs equal. Detects broken mappings (tested). |
| Production server with default settings | `node server-dist/main.mjs` | ✔ starts closed: HCG Connect not configured, no authority, payments disabled, downloads disabled. Refuses `HCG_STORE_PAYMENT_PROVIDER=test` in production |
| Dependency audit | `npm audit` | ✔ 0 vulnerabilities (`jose` pinned to 6.2.14, a release more than two weeks old) |
| Mutation check of the acceptance suite | manual | ✔ The suite catches all 5 deliberately introduced faults: an entitlement bypass, a signature bypass, idempotency removed, central re-check removed, and the amount check removed |

## Acceptance list ([ACCESS.md](ACCESS.md#acceptance-list))

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Logged-out users cannot retrieve protected binaries | ✔ passed | `server/test/acceptance.test.ts` §1 (401 for every file; forged cookie refused); e2e "signed-out visitors…" |
| 2 | Signed-in non-owners cannot download paid products | ✔ passed | §2 (403 `not_entitled`; `admin` role grants nothing; editions are separate) |
| 3 | Owners download the correct artifact | ✔ passed | §3 (bytes and SHA-256 match, `private, no-store`); e2e downloads the right `.deb` in Chromium |
| 4 | Failed payments and forged success redirects grant nothing | ✔ passed | §4: failed, pending, return URL, forged URLs, unsigned, wrongly signed, stale and under-priced events; client-sent price ignored; cross-site checkout refused. e2e "a failed payment and a forged return URL…" |
| 5 | Duplicate payment events do not duplicate purchases | ✔ passed | §5: the same event 3 times → `processed, duplicate, duplicate`; a second completion → `ignored`; 1 purchase |
| 6 | Logout, session expiry and revocation behave as documented | ✔ passed | §6: logout (a copied cookie fails); session restored after 3 days and ended after the 7-day idle limit; central session end refused after the 60 s window; HCG outage → 503, not a denial; refund and administrator revocation apply to the next request; subscription cancel keeps access until period end, then expiry removes it |
| 7 | Store website and app show consistent ownership | ✔ passed | §7: library, product access, HCG Repo access endpoint and Sileo `user_info`/`package info` agree for an owner and a non-owner |
| 8 | No public artifact URL bypasses the gate | ✔ passed | §8: static paths and traversal never serve private files; Sileo URLs are signed, session-bound, re-checked and expire after 120 s; the launch switch off gives "Downloads are not available yet." everywhere; every API response is `private, no-store` with `Vary: Cookie`; no binaries or Dropbox links in `dist/` |
| — | Store product → matching HCG Repo product | ✔ passed | `check:repo-mapping`; component tests check the hrefs (`/products/hcg-terminal-unleashed/`, `/products/hcg-nexus/`) |
| — | HCG Repo product → matching Store purchase page | ✔ passed | HCG Repo build: each `products/<key>/` links to `store…/apps/<slug>[?edition=…]` and `store…/auth/login?return_to=…`; the Store's access endpoint returns the matching `store_url` and `buy_url` (server test); `return_to` sign-in verified in e2e |

**These checks passed against a mock of HCG Connect and a TEST payment provider.** They have not been
run against live HCG, because HCG Store has no HCG Connect client, and no central entitlement grant API
or approved payment provider exists. Live verification is launch condition 3 in
[ACCESS.md](ACCESS.md).

## Other repositories changed

| Repository | Change | Checks run here |
|---|---|---|
| HCG-repo | Product pages `products/<key>/` linked to the Store; refuses non-public packages; optional `payment_endpoint` (empty) | ✔ 92 unit tests; ✔ `bin/hcgrepo smoke` for both base URLs (15 URLs, 0 errors) |
| HCG-Nexus | Settings › About › "HCG Repo" row via `HCGLauncher` | ✔ `scripts/check.sh`: 26,970 host checks, 0 failures, rule checks pass. Panel UI not compiled (needs Theos or macOS) |
| HCG-Terminal | Settings "HCG Repo" row, in the Unleashed build only | ✔ build-variant script, Xcode project generator unchanged. **Swift not compiled or tested:** no Swift toolchain here |
| HCG-Sentinel | Settings › About card | ✔ project generator unchanged, Python harness tests. **Swift not compiled or tested:** no Swift toolchain here |

## Not run / limitations

- No live HCG Connect sign-in, no live entitlement checks, no real payments, no real files.
- No device test of Sileo's payment flow, and no protected Packages-index entries (see
  [HCG-REPO.md](HCG-REPO.md)).
- Terminal and Sentinel Swift changes must be compiled in CI or Xcode before merging.
- Chromium only. No screen-reader or Lighthouse runs.
- `node:sqlite` is marked experimental on Node 22 and prints a warning at start-up.

## Screenshots

`docs/screenshots/`, captured with `npm run screenshots`:
- From the production build: home, browse, products, getting started and account. This includes
  `product-terminal-editions-1440.png`, showing editions, a clearly disabled checkout and "View on HCG
  Repo".
- **TEST-mode** account flow, labelled "Test mode" on screen:
  - `test-mode-not-owned-1440.png`
  - `test-mode-checkout-1440.png`
  - `test-mode-owned-1440.png`
  - `test-mode-library-1440.png`
- Fixture release pages: `fixture-release-panel-1440.png` and `fixture-release-history-390.png`.
