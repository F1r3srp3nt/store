# HCG Store: HCG Repo's payment provider for Sileo and Zebra

HCG Store is the commercial and entitlement authority for HCG Repo. Package managers sign in with HCG Connect through
HCG Store, see prices from HCG Store's offers, buy through HCG Store's checkout, list earlier purchases, and get
short-lived download grants for the exact `.deb` HCG Store approved.

**Status (27 Nov 2026): implemented and qualified against TEST servers. It is not deployed and not advertised.**
- The Studio's default availability is **Disabled**.
- HCG Repo's `[access] payment_endpoint` is still empty.
- Live payments do not exist: the server accepts only `none` or the TEST provider, and the TEST provider runs only in
  test mode.
- Public availability also needs `HCG_STORE_SILEO_PUBLIC_APPROVED=founder-approved` on the server.

## 1. Protocol (what the clients actually do)

The documentation sites `developer.getsileo.app` and `standards.tale.me` did not resolve from the build environment.
So the contract was taken from the clients' own source and is pinned by contract tests
(`server/test/sileo-provider.test.ts`):
- **Sileo** `c9f7015` (8 Oct 2024): `Sileo/Backend/Payment Manager/PaymentProvider.swift`, `PaymentAuthenticator.swift`,
  `PaymentPackageInfo.swift`, `PaymentManager.swift`.
- **Zebra** `e2f3c27` (15 Nov 2026): `Zebra/Tabs/Sources/Helpers/ZBPaymentVendor.m`, `JSONParsing/ZBPaymentVendor*.h`,
  `ZBDatabaseManager.m`.

| Step | Request | HCG Store answers |
|---|---|---|
| Discovery | `GET <repo>/payment_endpoint` (https only) | One line: `https://store.hakmicapitalgroup.com/api/sileo/v1/`. Published by HCG Repo, not by the Store. |
| Provider | `GET info` | `{ name, description, icon, authentication_banner: { message, button } }` |
| Sign-in | `GET authenticate?udid=&model=` in `ASWebAuthenticationSession` | HCG Connect PKCE sign-in, then `302 sileo://authentication_success?token=…&payment_secret=…` |
| Account | `POST user_info` `{ token, udid, device }` | `{ items: [package ids], user: { name, email } }` |
| Price | `POST package/<id>/info` (token optional), or `GET` from Zebra when signed out | `{ price: "€9.99", purchased: 0\|1, available: 0\|1 }` |
| Purchase | `POST package/<id>/purchase` `{ token, payment_secret, udid, device }` | `{ status: 1, url }` (the Store's checkout page), `{ status: 0 }` (already owned or nothing to buy), or `{ status: -1, error }` |
| Payment done | the checkout page links to `sileo://payment_completed` | Sileo and Zebra close the sheet; the next `info` shows `purchased: 1` |
| Download | `POST package/<id>/authorize_download` `{ token, version, repo, architecture, udid, device }` | `{ url }`: a single-use https grant |
| Sign-out | `POST sign_out` | `{ success: true }` |
| Errors | — | `{ success: false, error, recovery_url?, invalidate? }`. `invalidate: true` makes the client forget its token. |

Client behaviour the implementation relies on:
- Sileo asks for `package/<id>/info` **without a token** when signed out. The first version of this API answered 401,
  so Sileo would never have shown a price. It is fixed and tested.
- Sileo only calls the provider for packages tagged `cydia::commercial`. Free packages never reach it.
- Sileo's payment callback reports `success: false` even when the payment completed (a client quirk). The package page
  refreshes when it is reopened.
- `/repo-api/v1/sileo/` (the first path) remains an alias of `/api/sileo/v1/`.

### Repository Payment Specification v2 and Zebra

- **v2 is not implemented, and its content could not be checked here.** `standards.tale.me` did not resolve, and nothing
  about v2 has been assumed.
- **Current Zebra already works with this provider.** Zebra (master, Nov 2026) implements the same contract as Sileo:
  `payment_endpoint` discovery, the same endpoints, the `sileo://` callback scheme, `recovery_url`, `invalidate`, and the
  `GET` package-info optimisation, which is supported.
- The provider profile lists its protocols (`sileo-payment-provider-v1`). A v2 surface would be added under its own
  namespace without changing v1.
- **To evaluate v2:** allow `standards.tale.me` in the build environment, compare v2's endpoints and fields with the
  table above, and add contract tests before advertising it.

## 2. Security model

- **Credentials.** Sign-in uses HCG Store's existing HCG Connect PKCE flow (S256, state, nonce, one-time login
  attempts). Sileo receives HCG Store's own token and payment secret:
  - random values, stored only as SHA-256 hashes, never an HCG Connect token;
  - bound to a Store session and to the device, by an HMAC of the device identifier keyed with the Store secret. The
    identifier itself is never stored. Only the model, e.g. `iPhone14,2`, is kept for the account page;
  - valid for at most the session's absolute lifetime. They end with HCG session expiry, sign-out in Sileo, or
    revocation on the account page. Revocation also ends the bound session and any download grant not yet used;
  - a wrong `payment_secret` ends the credential. A missing one, sent by devices without a passcode, still has to pass
    the checkout page.
- **Purchases never grant.** `purchase` creates a server-priced checkout: the amount and currency come from the offer,
  and the channel and the version current at purchase are recorded. Only the payment provider's signed webhook grants
  the entitlement:
  - verified HMAC, a 5-minute tolerance, idempotent per event;
  - the amount and currency must match the checkout;
  - out-of-order refunds and disputes are remembered.

  The checkout page, `sileo://payment_completed` and Sileo's success screen grant nothing.
- **Downloads.** `authorize_download` checks, in order:
  - the credential is valid and on the same device;
  - the package's channel is active;
  - the `repo` is associated with HCG Store, in the profile and on the channel;
  - the architecture is distributed;
  - the account is entitled (paid: an HCG entitlement; sign-in packages: any signed-in account);
  - the downloads launch switch is on;
  - the update policy allows the version;
  - an approved, deliverable `.deb` matches that exact version (or its Debian revision) and architecture.

  The answer is an opaque 43-character grant, valid 120 s (`HCG_STORE_DOWNLOAD_URL_TTL_SECONDS`) and usable once. It is
  bound to the artifact and its SHA-256 and carries no account or credential data. Using it re-checks the credential,
  the session, the entitlement and the file hash, so refunds and revocations apply immediately. The file is streamed
  from private storage with `Cache-Control: private, no-store`. No storage, CDN or repository path serves paid bytes,
  and HCG Repo indexes them under a `Filename` that is never deployed.
- **No secrets in logs.** Nothing logs tokens, secrets, codes or device identifiers. The audit stores references
  (`pms_…`) and models only. The tests assert this.
- **Rate limits.**
  - Sign-in: 20 per minute per address.
  - Purchases: 10 per minute per credential.
  - Download grants: 30 per minute per credential.
  - Package info: 240 per minute per address.

## 3. Gates (nothing goes live by merging)

| Gate | Default | Who changes it |
|---|---|---|
| Provider availability (Studio): `disabled` / `internal` / `public` | `disabled` | Pricing and Offers permission or HCG's Founder policy |
| `public` really public | Runs as `internal` | Also needs `HCG_STORE_SILEO_PUBLIC_APPROVED=founder-approved` on the server |
| Internal testing | — | Only the Founder (confirmed by HCG's `/me` and `/access`) and people HCG grants an HCG Store permission can sign in |
| Payments (Studio): `off` / `test` | `off` | `test` only works with the TEST provider (test mode). Live: not implemented |
| Paid downloads | off | `HCG_STORE_PROTECTED_DOWNLOADS=enabled` + `HCG_STORE_LAUNCH_APPROVED=founder-approved` (existing launch decision) |
| Advertisement | none | HCG Repo `config/repo.toml` → `[access] payment_endpoint`. Set it only after public launch approval. |

## 4. Payment Provider Studio (Control Center → Payment provider)

- **Profile:** name, description, icon (the official `/brand/icon-512.png` or an https URL), sign-in banner and button,
  availability, payment mode, associated repositories and protocol. It is revisioned, so a stale save gets 409, and
  every change is audited.
- **Official defaults:**
  - Name: "HCG Store".
  - Description: "Official payment and distribution services for Hakmi Capital Group."
  - Banner: "Sign in with your HCG account to purchase packages and access your existing purchases."
  - Button: "Sign in with HCG Connect".
- **Health inspector:**
  - the info contract;
  - https;
  - the icon;
  - HCG Connect;
  - availability;
  - repositories;
  - payments;
  - downloads;
  - active packages;
  - per-package warnings: no offer, no approved `.deb`, an architecture mismatch.
- **Sileo preview:** a neutral rendering of the provider card and banner, plus the exact JSON bodies Sileo receives
  for `info` and for a package's signed-out `info`.
- **Repository packages (distribution channel):**
  - package ID → product and edition, with the status (draft, active or suspended);
  - access: `paid`, `account` (free with an HCG account) or `free` (public HCG Repo pool, never through the provider);
  - architectures, minimum and maximum iOS, update policy (`all-updates` / `same-major`) and repository.

  Saving is refused when:
  - the catalogue does not list the package ID on that edition;
  - an edition with approved offers is not `paid`;
  - a catalogue-free edition is `paid`;
  - another product already owns the package ID.

  Prices are never set here; they come from the offers. iOS limits are also enforced by the package's
  `Depends: firmware`, because Sileo does not send the iOS version.
- **Developers & sales:**
  - developers and their onboarding status (payout account, tax, identity; completed in HCG Payments, only recorded
    here);
  - product ownership: products without an owner are first-party;
  - commission agreements: added and ended, never edited, and overlaps are refused;
  - a sales report computed from the purchase records: gross, refunded, disputed, net, HCG commission and developer
    share per currency, with TEST and live sales kept apart. There is no second ledger;
  - **payout eligibility is always "not eligible"** while automated payouts are not activated, with the reasons listed.

Permissions:
- Reading: any HCG Store staff permission, or the Founder policy.
- Changes: the Pricing and Offers permission (`HCG_STORE_OFFERS_CENTRAL_ID`) or the Founder policy, plus the session's
  CSRF token.
- Customers get 403.

## 5. Customer account (My Library)

- **Purchase history** is one list for the website and Sileo/Zebra ("Bought in"). It shows status, refund state and an
  on-demand **receipt**: number, item, amount, channel, refund, masked payment reference. TEST purchases are labelled
  "no money moved, not a tax invoice".
- **Package versions available to your account** shows the newest approved version per owned repository package and
  whether the update policy includes it. HCG Store has no install evidence, so it never claims what is installed.
- **Package managers and devices** lists each Sileo or Zebra connection: app, device model, connected and last used,
  with **Sign out** per connection and **Sign out every package manager**.

## 6. HCG Repo contract (authenticated, staff)

- **`GET /api/v1/repo/packages`** lists every channel with access, architectures, iOS range and update policy, plus the
  approved versions with SHA-256 and size. It also returns the provider endpoint, but only once public.
- **`POST /api/v1/repo/packages/verify`** takes `{ package, version, architecture, sha256, repository }` and returns
  `ok`, or the problems:
  - not distributed (an orphaned listing);
  - the channel is not active;
  - wrong architecture or repository;
  - SHA-256 mismatch;
  - version mismatch.
- **`GET /api/v1/repo/releases?destination=hcg-repo`** (existing) lists approved and withdrawn releases. HCG Repo's
  `import-store-release` pins the Store artifact's SHA-256.

Release approval and artifact verification are unchanged: only releases approved in HCG Store, and their verified
files, are deliverable.

## 7. Qualification

`npm test`, file `server/test/sileo-provider.test.ts`. The simulated clients send exactly what Sileo and Zebra send and
parse the answers the way they do.

| # | Requirement | Test |
|---|---|---|
| 1 | Sileo discovers HCG Store | `1. discovery…`: `payment_endpoint` of the internal source; HCG Repo receives the endpoint only when public; disabled answers nothing |
| 2 | Official branding | `GET info…` and `2. official HCG Store branding` |
| 3 | HCG Connect authentication | `3. HCG Connect authentication…`: PKCE S256, no cookie, hashes only, no device identifier stored, nothing logged |
| 4 | Purchased package identifiers | `4-9…` (`user_info.items`) |
| 5 | Prices | `package info is answered without a token…` and `4-9…` (`€9.99`) |
| 6 | TEST purchase | `4-9…` (status 1 → checkout page → TEST provider) |
| 7 | Verified confirmation grants | `4-9…`: forged and wrong-amount webhooks refused, duplicates idempotent, the page grants nothing |
| 8 | Sileo downloads the authorised `.deb` | `4-9…` (bytes and SHA-256 equal) |
| 9 | Re-download of earlier purchases | `4-9…` (new device, new sign-in) |
| 10 | Unauthorised and expired attempts denied | `10. …`: other account, version, architecture, repository, replay, expiry, tampering, a stolen credential on another device, public paths |
| 11 | Refunds and revocations | `11. …`: refund and dispute (including grants already issued), revocation from the account page, sign-out from Sileo |
| 12 | Free packages unaffected | `12. …` and the client facts in section 1 (Sileo never calls the provider for free packages) |
| — | Payments off, failed, cancelled, expired checkout, CSRF | `failed and cancelled TEST payments…` |
| — | Payment secret | `a wrong payment secret…` |
| — | Update eligibility | `same-major update policy…` |
| — | Gates | `internal testing…`, `moving from public back to internal testing…` and `is disabled by default…` |
| — | Studio, channel validation, health, preview, HCG Repo contract, developers and sales | `Payment Provider Studio…` |
| — | Browser | `e2e/admin.spec.ts`: the Founder configures the provider in the Studio |

## 8. Testing on your iPhone

You need a jailbroken iPhone with **Sileo**, a rootless jailbreak (`iphoneos-arm64`), and a Mac with this repository.

### Stage A: the complete flow against a TEST Store on your Mac

- No production and no money are involved.
- Sign-in is a **TEST identity** from the mock HCG Connect, not your HCG account. It shows which parts are Sileo's and
  which are HCG Store's.
- The package is a harmless TEST `.deb` that installs one text file:
  `/var/jb/usr/share/doc/com.example.fixture.quasar.unleashed/README.txt`.

1. On the Mac, in `web-hcg-store/`, install the dependencies:

   ```bash
   npm ci
   ```

2. Build the TEST site:

   ```bash
   npm run build:fixture
   ```

3. Start an HTTPS tunnel to port 4180. Sileo only accepts https providers. With Cloudflare's free quick tunnel
   (`brew install cloudflared`):

   ```bash
   cloudflared tunnel --url http://127.0.0.1:4180
   ```

   Copy the `https://….trycloudflare.com` address it prints and keep the tunnel running.
4. In a second terminal, start the TEST Store with that address:

   ```bash
   DEVICE_ORIGIN=https://<the address> npm run sileo:device-test
   ```

   It prints the source to add and the TEST package's SHA-256.
5. **Discovery (1).** On the iPhone: Sileo → Sources → **+** → `https://<the address>/api/sileo/v1/internal-source/` →
   Add Source. Sileo reads `payment_endpoint` from that source.
6. **Branding (2).** Sileo → Settings → payment providers. **HCG Store** appears with the official icon and description.
   Open the source's package list: the banner reads "Sign in with your HCG account…" with **Sign in with HCG Connect**.
7. **Price (5).** Open **Fixture Quasar Shell Unleashed**. The button shows **€9.99**.
8. **Sign-in (3).** Tap the price or the banner button. A sign-in sheet opens and closes by itself: the TEST identity
   signs in. Settings → HCG Store shows "TEST device tester".
9. **Purchase (6, 7).** Tap **€9.99** and authenticate with Face ID or your passcode (Sileo releases the payment secret).
   - The HCG Store TEST checkout opens: "TEST MODE — no real payment is taken". Tap **Simulate successful payment**.
   - The page shows "Purchase confirmed". Tap **Return to your package manager**.
   - Reopen the package page. The button now reads **Get**, because the provider's signed event granted access.
   - Optional negative check: buy again from a fresh state and tap **Simulate failed payment** or **Cancel**. The button
     keeps showing €9.99.
10. **Purchased identifiers (4).** Settings → HCG Store lists the package under your purchases.
11. **Install (8).** Tap **Get** → Queue → **Confirm**. Sileo asks for a download grant, downloads the `.deb`, checks the
    SHA-256 against the index, and installs it. To check:
    - Filza: `/var/jb/usr/share/doc/com.example.fixture.quasar.unleashed/README.txt` exists;
    - on the Mac: `curl http://127.0.0.1:4181/state` shows the grant as used.
12. **Re-download (9).** Remove the package in Sileo, then install it again. It downloads without paying. On a second
    device signed in to the same TEST identity, it is also listed as purchased.
13. **Denied and expired (10).** On the Mac, check the grant states:

    ```bash
    curl http://127.0.0.1:4181/state
    ```

    Every grant is used once. Re-opening a used grant URL in Safari answers "already been used".
14. **Refund (11).** On the Mac:

    ```bash
    curl -X POST http://127.0.0.1:4181/refund
    ```

    In Sileo, pull to refresh. The package shows €9.99 again and **Reinstall** is refused with "Your HCG account does
    not include this package."
15. **Revocation (11).** Buy again (step 9).
    - On the iPhone, open `https://<the address>/library` in Safari. The TEST identity signs in.
    - Under **Package managers and devices**, tap **Sign out** next to Sileo on your iPhone.
    - Back in Sileo, the next action asks you to sign in again; the credential was forgotten.
16. **Free packages (12).** Install any free package from HCG Repo or another public repository. Sileo installs it
    without contacting HCG Store; the provider only serves `cydia::commercial` packages.
17. Clean up:
    - remove the TEST package and the TEST source in Sileo;
    - stop the two terminals. All TEST data lived in memory.

### Stage B: real HCG Connect on store.hakmicapitalgroup.com (after you approve a deploy)

1. Deploy main. On the site, open Control Center → **Payment provider**.
2. Set **Availability: Internal testing** and **Payment mode: Off**. Production has no TEST provider and no live
   provider, so purchases answer "not available yet".
3. Under **Repository packages**, add `com.hakmicapitalgroup.hcgnexus` → HCG Nexus (Jailbreak), **Paid**,
   `iphoneos-arm64`, repository `https://store.hakmicapitalgroup.com/api/sileo/v1/internal-source/` for the test (and
   add that URL to the profile's repositories).
4. In Sileo, add `https://store.hakmicapitalgroup.com/api/sileo/v1/internal-source/`.
5. Sign in with your **real HCG account** (3). Settings → HCG Store shows your account and, because HCG's Founder policy
   covers every product, HCG Nexus as purchased (4).
   If HCG Store has not yet published an approved HCG Nexus `.deb`, the internal source lists no package. Sign-in, the
   account and revocation can still be checked.
6. Downloads stay refused ("Downloads are not available yet.") until protected downloads are launched. Sign out from
   the account page and confirm Sileo asks again (11).
7. Set availability back to **Disabled** when done. HCG Repo's public `payment_endpoint` stays empty throughout.

## 9. What remains before customers can buy

1. **Live payment provider.** Choose and approve HCG Payments' provider: merchant of record or Stripe, VAT, refunds and
   disputes. Then implement its webhook verification in `payments.ts`, using the same event contract. Today
   `HCG_STORE_PAYMENT_PROVIDER` only accepts `none` or `test`.
2. **Central grants (D5).** HCG confirms the purchase-grant endpoint (`HCG_STORE_GRANT_API_URL`), so verified purchases
   become HCG entitlements.
3. **Offers and releases.** HCG sets prices for HCG Nexus in HCG ERP, they are mirrored into `offers.json`, and the
   `.deb` is approved and published in HCG Store.
4. **Launch decisions.**
   - protected downloads (`HCG_STORE_LAUNCH_APPROVED`);
   - public provider (`HCG_STORE_SILEO_PUBLIC_APPROVED`);
   - then HCG Repo's `payment_endpoint` and the `cydia::commercial` index entries.
5. **Third-party payouts.** Payout provider onboarding, tax and identity in HCG Payments, then founder approval.
