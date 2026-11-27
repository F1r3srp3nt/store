# HCG Store ⇄ HCG Repo

HCG Repo (`F1r3srp3nt/HCG-repo`, `https://repo.hakmicapitalgroup.com/`: public metadata only, no protected package listed) is the
distribution entry point for jailbreak packages and terminal tools. HCG Store handles product
discovery, checkout, purchase history and ownership. Both apply the same ownership rules, because
HCG Repo asks the Store, and the Store asks HCG.

## Explicit mapping

Defined in this repository's `catalogue/products.json` (`hcgRepo`, edition `identifiers`) and in HCG
Repo's `config/products.toml` (`key`, `store_slug`, `store_edition`, `package_ids`).
`npm run check:repo-mapping -- <HCG-repo checkout>` verifies both directions, the package IDs and the
base URLs.

| Store page | HCG Repo page | Package ID | Layouts declared |
|---|---|---|---|
| `/apps/hcg-terminal?edition=unleashed` | `/products/hcg-terminal-unleashed/` | `com.hakmicapitalgroup.hcgterminal.unleashed` | `iphoneos-arm64` (rootless), `iphoneos-arm` (rootful) |
| `/apps/hcg-nexus?edition=jailbreak` | `/products/hcg-nexus/` | `com.hakmicapitalgroup.hcgnexus` | `iphoneos-arm64` (rootless release target; rootful unsupported until verified) |
| `/apps/hcg-sentinel` | `/products/hcg-sentinel/` | none: Sentinel has no jailbreak package | — |

The standard HCG Terminal edition (`com.hakmicapitalgroup.hcgterminal`) is reserved by HCG Repo and
never shipped there.

Routes: `products/<key>/` is a new, explicit HCG Repo route added for this integration. The existing
APT source `<base>repo/` and its depictions are unchanged, so **the source URL users add to Sileo
stays stable**.

## What each side shows

| Visitor | HCG Store product page | HCG Repo product page |
|---|---|---|
| Signed out | "Sign in to check access", price if HCG set one, "View on HCG Repo" | "Sign in to check access" (→ Store sign-in, returning to the product) and "View in HCG Store" |
| Signed in, does not own a paid product | "Buy Product" (enabled only when checkout is ready and the product is approved for sale) | "Buy Product" → the matching Store page |
| Signed in, product not for sale | Disabled "Buy Product" with the reason | Disabled "Not for sale yet" |
| Owner | "Owned" and "Get from HCG Repo" | "Owned"; "Get from HCG Repo" stays disabled with "Downloads are not available yet." until release approval and protected delivery are live |
| Store unreachable | "Access could not be checked right now." | Plain links plus "Access could not be checked right now." |

HCG Repo pages ask `GET <store>/api/v1/repo/products/<key>/access` with the Store cookie. Both sites
are on `hakmicapitalgroup.com`, so the cookie is same-site. The Store allows only the origins in
`HCG_STORE_REPO_ORIGINS` (credentialed CORS). The GitHub Pages test domain is cross-site, so there
the pages fall back to the plain links.

## Package-manager delivery (Sileo and Zebra): implemented in the Store, not enabled

HCG Store is HCG Repo's payment provider at `https://store.hakmicapitalgroup.com/api/sileo/v1/`
(`/repo-api/v1/sileo/` is an alias). The protocol, security model, gates, Payment Provider Studio, account page,
qualification and iPhone test instructions are in [SILEO-PAYMENT-PROVIDER.md](SILEO-PAYMENT-PROVIDER.md).

- **Discovery:** HCG Repo publishes `repo/payment_endpoint` from `[access] payment_endpoint`, which stays **empty** until
  the founder approves public availability (`HCG_STORE_SILEO_PUBLIC_APPROVED`) and launch.
- **Commercial authority:** prices, purchases, refunds and entitlements live in HCG Store; HCG Repo keeps none. Each
  package is connected to a Store product by its distribution channel (Control Center → Payment provider).
- **Contract for HCG Repo (staff-authenticated):**
  - `GET /api/v1/repo/packages`: channels and approved versions with SHA-256;
  - `POST /api/v1/repo/packages/verify`: refuses orphaned listings and mismatched versions, architectures, repositories
    or hashes;
  - `GET /api/v1/repo/releases?destination=hcg-repo`: unchanged.
- **Zebra:** current Zebra uses the same provider contract, and its signed-out `GET` package info is supported. Plain
  APT with HTTP authentication is not offered.
- **Protected index entries:** done in HCG Repo (16 Nov). A Store-held package is pinned by the Store artifact's SHA-256
  and indexed as `cydia::commercial` with a `Filename` that is never deployed.

## Native apps

Each app has an "HCG Repo" entry that opens its product page over HTTPS, using the app's existing
link convention. The app itself makes no request, and no identifier is added to the URL.

| App | Where | URL |
|---|---|---|
| HCG Terminal Unleashed (only the Unleashed build) | Settings, below "Distribution" | `https://repo.hakmicapitalgroup.com/products/hcg-terminal-unleashed/` |
| HCG Nexus | Panel Settings › About | `https://repo.hakmicapitalgroup.com/products/hcg-nexus/` |
| HCG Sentinel | Settings › About | `https://repo.hakmicapitalgroup.com/products/hcg-sentinel/` |
