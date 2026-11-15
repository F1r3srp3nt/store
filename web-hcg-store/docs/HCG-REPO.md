# HCG Store ⇄ HCG Repo

HCG Repo (`F1r3srp3nt/HCG-repo`, future `https://repo.hakmicapitalgroup.com/`, not live) is the
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

## Package-manager delivery (Sileo): implemented in the Store, not enabled

Inspected from Sileo's source (`Sileo/Backend/Payment Manager/*.swift`). The official documentation
site was unreachable from the build environment.

- **Discovery:** Sileo reads `<repo>/payment_endpoint`. It must be HTTPS. HCG Repo can emit it from
  `[payments] endpoint`, which is **empty**, so it is disabled.
- **Sign-in:** Sileo opens `<endpoint>authenticate` in the system web-authentication sheet. The Store
  runs the normal HCG Connect sign-in, then redirects to
  `sileo://authentication_success?token=…&payment_secret=…`. The token is a **Store-issued, revocable
  HCG Repo token** bound to that Store session. It is never an HCG Connect token, never goes in the
  APT source URL, and later requests send it in the JSON body.
- **Endpoints served by the Store** at `/repo-api/v1/sileo/`:
  - `info`, `user_info`;
  - `package/<id>/info`: price, `purchased`, `available`;
  - `package/<id>/purchase`: never grants; returns the Store's buy page;
  - `package/<id>/authorize_download`: re-checks session, entitlement, release approval and the
    launch switch, then returns a 120-second signed HTTPS URL;
  - `sign_out`.
- **Zebra:** its source has models for the same JSON fields, but no client calling this API was found.
  Treat Zebra and plain APT as **unsupported for paid packages**. APT with HTTP authentication would
  need per-user credentials in `auth.conf` and is not offered.

### Remaining work before installation can be offered

1. **Protected index entries.** HCG Repo must list paid or login-gated packages in `Packages`
   (control metadata with `Tag: cydia::commercial`) without putting the `.deb` in the public `debs/`
   directory. Sileo then fetches the file only through `authorize_download`. Today the validator
   refuses non-public packages entirely, which keeps them safe but uninstallable.
2. Go live with the Store and enable launch (see [ACCESS.md](ACCESS.md#launch-conditions-all-must-hold-before-downloads-are-enabled)),
   then set HCG Repo's `[payments] endpoint`.
3. Migrate HCG Repo to its custom domain. Its own `docs/CUSTOM_DOMAIN.md` covers this.
4. Test on a device with Sileo: sign in, buy, install and sign out.

## Native apps

Each app has an "HCG Repo" entry that opens its product page over HTTPS, using the app's existing
link convention. The app itself makes no request, and no identifier is added to the URL.

| App | Where | URL |
|---|---|---|
| HCG Terminal Unleashed (only the Unleashed build) | Settings, below "Distribution" | `https://repo.hakmicapitalgroup.com/products/hcg-terminal-unleashed/` |
| HCG Nexus | Panel Settings › About | `https://repo.hakmicapitalgroup.com/products/hcg-nexus/` |
| HCG Sentinel | Settings › About | `https://repo.hakmicapitalgroup.com/products/hcg-sentinel/` |
