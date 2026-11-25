# Payments and ownership

**Status:** checkout works in **TEST MODE ONLY**. No live payment provider is implemented, because
HCG has no approved payment integration. Live payments are refused by the server's configuration
(`HCG_STORE_PAYMENT_PROVIDER` accepts only `none` or `test`, and `test` only in test mode). No price
exists for any real product (`server/data/offers.json` is empty).

## What was inspected

No repository contains a payment integration to reuse. There are no Stripe keys, price IDs, checkout
code or webhook handlers anywhere. What exists:

- CardX documents "verified via webhook only" for a future orders table, and has a `NotEnabled`
  checkout.
- HCG ONE Unleashed lists the open decision: a merchant of record (Paddle, Lemon Squeezy) or HCG's own
  Stripe account with VAT handling, "get accountant or legal advice first".
- HCG's live account page says "Paid plans aren't available yet — nothing here is billed".

**Choosing and approving the provider is a founder decision.** HCG Store does not make it.

## Flow (implemented)

1. The product page shows an offer only if the server has one that is `approved-for-sale`. Prices are
   formatted from the server's integer minor units and currency.
2. **Buy Product** sends only `{ offerId }` to `POST /api/v1/checkout`. That requires a signed-in,
   re-confirmed session and the Store's own `Origin`. It is refused if the person already owns the
   edition. The server prices the checkout from its offers file; a price or currency sent by the
   browser is ignored.
3. The person completes checkout at the provider. In test mode this is a page served by the Store and
   marked "TEST MODE — no real payment is taken". It never asks for card details.
4. The provider's **signed webhook** is the only thing that changes ownership. Signatures are
   timestamped HMAC-SHA256 over the raw body, with a 5-minute tolerance. Each event is processed
   once, keyed by provider and event ID. The amount and currency must equal the checkout's.
5. The return page (`/checkout/return`) only reports what the server has recorded. Arriving there,
   or at a forged URL, changes nothing.

| Provider event | Effect |
|---|---|
| `checkout.completed` | Creates **one** purchase per checkout (unique key) and grants exactly the editions the offer's `grants` lists. |
| `checkout.pending` | Marks the checkout pending. Nothing is granted. |
| `checkout.failed` | Marks the checkout failed. Nothing is granted, and a later completion is rejected. |
| `payment.refunded`, `payment.disputed` | Marks the purchase refunded or disputed and revokes its grants. |
| `subscription.renewed` | Extends the entitlement to the new period end. |
| `subscription.canceled` | Keeps access until the paid period ends; no renewal. |
| `subscription.expired` | Revokes the grants. |
| Duplicate event | Ignored (`duplicate`). |

Editions: buying one edition grants only what the offer's `grants` lists, for example
`[{ "edition": "unleashed" }]`. `"*"` (every edition) is allowed only when the configured licence
says so.

Mapping to HCG (`server/data/offers.json`, validated at start):

| Offer field | Maps to | Rule |
| --- | --- | --- |
| `productId` | Store catalogue product | must exist |
| `centralProductId` | HCG central product ID | must equal the product's confirmed `registry.centralId`; products without one cannot be sold |
| `editionId`, `grants[].edition` | HCG edition key (`centralEditionKey`, licence scope `edition:<key>`, D2) | every granted edition must have a central key; `"*"` only by explicit licence |
| `grants[].features` | HCG feature keys of that product (e.g. `download` once registered, D3) | listed explicitly, never implied; no duplicates; `store.*` staff permissions are refused |

Each verified purchase becomes one central grant per granted edition (`store:<provider>:<environment>:<purchase>:<edition>`)
through the outbox, with exactly those features. Refunds, disputes and expiry revoke that purchase's grants only.
`offers.json` stays empty: HCG has set no price and approved no provider.

Preorders: none. An offer can be `approved-for-sale` only for an edition with an approved current
release. The server refuses to start otherwise.

## HCG Payments provider (test mode only)

`HCG_STORE_PAYMENT_PROVIDER=hcg-payments` sends checkout to HCG Payments (HCG's payment orchestration
service, repository HCG-Payments) instead of the Store's own test ledger. It is refused outside test mode and
requires `HCG_STORE_ENTITLEMENT_AUTHORITY=hcg-ecosystem`.

- The Store sends `{ product, price, sub }` server to server (signed, idempotent per Store checkout attempt) and
  redirects the browser to the provider-hosted page HCG Payments returns. A price that differs from the Store's
  offer is refused.
- HCG Payments verifies the provider's signed webhook, re-reads the payment from the provider, and asks HCG's
  licensing to grant or revoke. The Store never grants anything for these purchases; downloads are still decided
  by `/check` and the delivery gates below.
- The Store keeps only `hcg_payments_checkouts` (its attempt ID ↔ HCG Payments order). The return page and the
  account's purchase list show HCG Payments' recorded status for display only.
- Settings: `HCG_STORE_PAYMENTS_URL`, `HCG_STORE_PAYMENTS_CLIENT_ID`, `HCG_STORE_PAYMENTS_CLIENT_SECRET` (secret
  store only), and an `offers.json` entry with `payments: { productId, priceId }`.

The local test environment that runs HCG Store, HCG Payments, a test licensing service and Stripe test mode
together is `npm run testenv` in the HCG-Payments repository.

## Where ownership is recorded

Entitlements belong to HCG. In production the Store would ask HCG's ecosystem API, but HCG has not
published a grant or revoke endpoint, so purchases cannot be fulfilled centrally yet. Checkout
therefore stays unavailable with the `hcg-ecosystem` authority, which has `canGrant = false`. The
`test-ledger` authority stands in for HCG in test mode only, so the whole flow can be tested.

## Adding a live provider (after founder approval)

Implement the provider's checkout-session creation in `server/src/app.ts`. Add its webhook route with
the provider's own signature verification, and map its events to the event types above. Reuse
`PaymentLedger.apply`, which already provides idempotency, amount checks and grants. Then:

1. Run it in the provider's **test mode** against the acceptance suite.
2. Confirm HCG's central grant API.
3. Add real offers and prices supplied by HCG.
4. Get explicit founder approval.

Provider keys go only in the server's secret store, never in `VITE_` variables.

## Checkout inside native apps: platform requirements (not implemented)

There is no native HCG Store app. The Store website is the only checkout surface. Before any app
offers purchases, its distribution channel decides what is allowed. Verify the current rules at
implementation time, because they change.

| App / edition | Channel (stated by its repository) | What applies |
|---|---|---|
| HCG Terminal (standard), HCG Mail iOS | Intended App Store / TestFlight | Apple's App Review Guidelines (section 3.1) generally require In-App Purchase to unlock digital features or content inside the app. Whether and how an app may link to an external purchase page depends on the storefront and current Apple rules. **Do not embed or link the web checkout without checking them.** |
| HCG Terminal Unleashed, HCG Nexus (jailbreak) | HCG Repo via Sileo | Not distributed by Apple. Sileo's payment-provider protocol opens the Store's page in the system web-authentication sheet (see [HCG-REPO.md](HCG-REPO.md)). Purchases still complete on the Store. |
| HCG Nexus app, HCG Sentinel | Development installs (Xcode / Configurator) only | No distribution channel yet, so there is no in-app checkout. Each app only links to its HCG Repo page. |
| HCG Clarity, HCG Executable Maker (macOS, Windows, Linux) | Direct download | Web checkout on the Store is fine. A Mac App Store or Microsoft Store version would bring that store's commerce rules. |
| HCG Mail (Windows) | Direct download | Web checkout on the Store. |
