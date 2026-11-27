# HCG Repo ⇄ HCG Store: commercial packages (contract `hcg.store.repo-entitlements/1`)

HCG Store is the commercial interface for HCG Repo's jailbreak packages: product and edition mapping, prices,
checkout, purchase history and delivery of protected `.deb` files. **HCG decides entitlements** (licences,
subscriptions, refunds and revocations are HCG's central records, checked live with the person's own HCG session).
HCG Repo asks; it never decides and never holds a paid package.

**Status: implemented and tested in the TEST environment. Not active in production.** Production has no server-to-
server key, payments are `none` and protected downloads are `disabled`; HCG Repo's `[access] payment_endpoint` stays
empty. Activation is separate and needs the founder's approval (section 7).

## 1. Parties and what each holds

| | Holds | Never holds |
|---|---|---|
| HCG (central) | Accounts, licences, subscriptions, refunds, revocations (`/check`, grant/revoke outbox) | Package files |
| HCG Store | Mapping (catalogue identifiers), offers, checkout, release lifecycle, private `.deb` storage, free testing windows, package-manager tokens | Card data (payment provider), central decisions |
| HCG Repo | APT index and depictions; `cydia::commercial` entries pinned by SHA-256 | Paid `.deb` files (never a GitHub asset or a static file), people's identities, tokens |
| Sileo / Zebra | A Store-issued package-manager token and payment secret (in the device keychain) | HCG Connect tokens |

## 2. Package-manager protocol (Sileo and Zebra)

Verified from the clients' sources: Sileo `c9f7015` (`Sileo/Backend/Payment Manager/*.swift`) and Zebra `e2f3c27`
(`ZBPaymentVendor.m`, 15 Nov 2026). Both implement the same payment-provider API. HCG Store serves it at
`https://store.hakmicapitalgroup.com/repo-api/v1/sileo/` (the value of HCG Repo's `[access] payment_endpoint` once
approved).

| Step | Request | HCG Store |
|---|---|---|
| Discovery | `GET info` | Name, icon, sign-in banner |
| Sign-in | `GET authenticate?udid&model` in the app's web-authentication session | HCG Connect sign-in, then `sileo://authentication_success?token=…&payment_secret=…`. The token is Store-issued, revocable and bound to the Store session; never an HCG Connect token |
| Package state | `POST package/<id>/info {token}` · Zebra signed out: `GET package/<id>/info` | Price, `purchased`, `available` |
| Purchase | `POST package/<id>/purchase {token, payment_secret}` | `status: 0` already owned or free · `-1` not for sale (with the reason) · `1` + `url`: a signed 30-minute purchase context on this Store, bound to the package and this account |
| Checkout | The app opens `url` (callback scheme `sileo`) | Same HCG account required (another account gets 403) → the Store's own product page and checkout → after the provider's **verified** payment event, `checkout/<ctx>/return` redirects to **`sileo://payment_completed`**. A return before the payment is confirmed says so and grants nothing |
| Restore purchases | `POST user_info {token}` | `items`: every package the account owns or may use free right now (free release or open testing window) |
| Download | `POST package/<id>/authorize_download {token, version, architecture}` | Re-checks session and entitlement, version and architecture, then a 120-second signed HTTPS URL on this Store; the file is re-authorised when fetched |
| Sign out | `POST sign_out {token}` | Token revoked |

`udid`, `model` and `device` are sent by the apps and are **ignored and never stored** (tested: no table contains
them).

## 3. Server-to-server API (HCG Repo's servers → HCG Store)

Base `https://<store>/api/s2s/v1/repo/`. Off unless `HCG_STORE_REPO_S2S_KEY_ID` and `HCG_STORE_REPO_S2S_SECRET` (Fly
secret, ≥ 32 bytes base64) are set; HCG Repo holds the same key in its own secret store.

**Authentication** (every request): headers `X-HCG-Key-Id`, `X-HCG-Timestamp` (Unix seconds, ±300 s),
`X-HCG-Nonce` (16-64 URL-safe characters, each accepted once), `X-HCG-Signature` =
`base64url(HMAC-SHA256(secret, METHOD + "\n" + PATH?QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(BODY))))`.
Failures answer `401 unauthenticated` with the reason (`unknown_key`, `stale_or_missing_timestamp`,
`missing_nonce`, `bad_signature`, `replayed`).

### `GET packages`

The mapping and what may be delivered now. No file URL, storage location or account data.

```json
{ "format": "hcg.store.repo-entitlements/1", "generatedAt": "…", "payments": "disabled | test | …",
  "packages": [{
    "packageId": "com.hakmicapitalgroup.hcgnexus", "productId": "hcg-nexus", "slug": "hcg-nexus",
    "editionId": "jailbreak", "editionName": "…", "centralProductId": "…", "centralEditionKey": "…",
    "repoKeys": ["hcg-nexus"], "pricingModel": "paid | subscription | free | hcg-account | none | not-set",
    "delivery": "commercial | free-with-account",
    "freeTesting": { "endsAt": "…", "releaseId": "rel-…" } | null,
    "storeUrl": "https://store…/apps/hcg-nexus?edition=jailbreak",
    "paymentEndpoint": "https://store…/repo-api/v1/sileo/",
    "currentVersions": [{ "version": "1.2.0", "architectures": ["iphoneos-arm64"], "fileName": "…deb", "sha256": "…", "releaseId": "…" }],
    "downloadsEnabled": false
  }] }
```

`currentVersions` are approved catalogue files and the **current** published HCG Store release of each target
(product, edition, platform, architecture, channel). Superseded, disabled, revoked and withdrawn releases are never
listed. HCG Repo pins each index entry to its SHA-256 (`import-store-release`) and marks it `cydia::commercial`.

### `POST entitlements/verify`

```json
{ "repoToken": "<the package manager's Store-issued token>", "packageId": "…", "version": "1.2.0-1",
  "architecture": "iphoneos-arm64", "purpose": "download | listing" }
```

HCG Repo can only ask about a person who signed in through a package manager (it presents that person's token); it
can never name an arbitrary account.

```json
{ "format": "hcg.store.repo-entitlements/1", "checkedAt": "…", "packageId": "…",
  "decision": "allow | deny | unknown",
  "reason": "entitled | not_entitled | token_invalid | downloads_not_available | no_eligible_release | version_not_eligible | architecture_not_available | unknown_package | hcg_unavailable",
  "entitled": true, "basis": "entitlement | free | free-testing | null", "validUntil": "… | null",
  "product": { "id": "…", "editionId": "…", "centralProductId": "…" },
  "requested": { "version": "…", "architecture": "…", "purpose": "download" },
  "eligibleVersions": [{ "version": "…", "architectures": ["…"], "sha256": "…", "releaseId": "…" }],
  "delivery": { "via": "hcg-store", "endpoint": "https://store…/repo-api/v1/sileo/package/<id>/authorize_download" } | null,
  "cacheSeconds": 60 }
```

| Case | Answer |
|---|---|
| Purchased licence (HCG) | `allow`, `basis: entitlement`, `validUntil: null` |
| Subscription (HCG period) | `allow` with `validUntil` = period end; after it, `deny not_entitled` |
| Temporary free testing (Store window on a published release) | `allow`, `basis: free-testing`, `validUntil` = window end; only that release's versions are eligible |
| Refund, chargeback, HCG revocation | `deny not_entitled` on the next request (central check; the Store's refund events reach HCG through the grant/revoke outbox) |
| Version not current, wrong architecture | `deny version_not_eligible` / `architecture_not_available`, with `eligibleVersions` |
| Launch switch off (production today) | `deny downloads_not_available` (`entitled` still says what HCG decided) |
| HCG unreachable | `503`, `decision: unknown`: **fail closed**, never cache |

`cacheSeconds` is at most 60 and never beyond `validUntil`; denials are never cached. Delivery stays with HCG Store
(`authorize_download`); this API never returns a file or a file URL.

## 4. Version eligibility

A version is eligible when it is the current approved release for the requested architecture (Debian version equal
to the release version, or `<version>-<revision>`). HCG has no central field for "updates until" or major-version
licences; until it does, a licence covers the current release. Older versions stay in the Store's history for
administrators but are not delivered to customers.

## 5. Purchase restoration and refunds

- Restoration is `user_info`, computed live from HCG's records and the Store's free windows. A new device, a reinstall
  or a second package manager restores by signing in.
- A refund is a payment-provider event (`payment.refunded`): the Store marks the purchase refunded and queues the
  revocation for HCG; the next verification, `user_info` and `authorize_download` deny. Download links already issued
  are re-checked when used.

## 6. TEST evidence

`server/test/repo-commerce.test.ts` (TEST ledger for HCG, TEST payment provider):

- Server-to-server API off unless configured; unsigned, wrongly signed, stale and replayed requests refused.
- Package listing: mapping, pricing model, current versions with SHA-256, no file URLs or account data.
- Purchase from the package manager: status 1 → Store URL → sign-in → same-account check → product page → TEST
  checkout → `sileo://payment_completed`; restore lists the package; `verify` allows the current version and refuses
  other versions and architectures; delivery works; no device identifier stored.
- Refund: verification, delivery and restore deny on the next request.
- Subscription: allowed until HCG's period end, denied after; HCG revocation applies immediately and kills an issued
  link; sign-out ends the token.
- Free testing: a published Store `.deb` (uploaded, approved and published through the release lifecycle) is allowed
  to a non-owner while the window is open (`basis: free-testing`), and denied once it ends.
- Production posture: payments off → purchase answers `-1`; downloads off → `deny downloads_not_available`.

`e2e/repo-purchase.spec.ts` (real browser): the same purchase in a browser page standing in for the app's
web-authentication session, ending with the `sileo://payment_completed` redirect, then restore and download.

## 7. Activation (not done; each step needs approval)

1. HCG: a payment provider for production and the launch conditions in [ACCESS.md](ACCESS.md); founder approval.
2. HCG Store: offers approved for sale, `HCG_STORE_PAYMENT_PROVIDER`, `HCG_STORE_PROTECTED_DOWNLOADS`, and (only if
   HCG Repo runs a server that needs it) `HCG_STORE_REPO_S2S_KEY_ID` / `HCG_STORE_REPO_S2S_SECRET` as Fly secrets.
3. HCG Repo: `[access] payment_endpoint = "https://store.hakmicapitalgroup.com/repo-api/v1/sileo/"`, paid packages
   imported with `import-store-release` (pinned SHA-256, `cydia::commercial`, file never deployed).
4. Device test with Sileo and Zebra: sign in, buy, install, restore on a second device, refund, sign out.
