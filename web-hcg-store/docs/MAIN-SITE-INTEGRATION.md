# HCG Store ↔ Main Site integration: decisions and contracts

16 November 2026 · current state after the main site's answer to
[MAIN-SITE-HANDOFF-REQUEST.md](MAIN-SITE-HANDOFF-REQUEST.md) and the founder's decisions D1–D6.

HCG Store now speaks the main site's real Ecosystem API contract, and its side of decisions D2 and D5 is
implemented and tested against mocks. Nothing has been verified live from HCG Store: its build
environment cannot reach the main site. The main-site work for D2–D5 is specified, not built: the
main site's code is not in a repository HCG Store's developers can reach. Production migrations,
credential activation and publication stay under the founder's manual control.

## Status labels

| Label | Meaning |
| --- | --- |
| **LIVE-VERIFIED (main site)** | The main site observed it on the live system on 16 Nov 2026. HCG Store has not re-observed it. |
| **DEPLOYED** | In the main site's deployed code, per its answer. |
| **PREVIEW** | In the main site's code and tested there; not published. |
| **PROPOSED** | A contract offered for review. It does not exist yet. |
| **STORE: IMPLEMENTED** | Built in this repository and tested against mocks of the contracts below. Not run against live HCG. |
| **DECISION** | Decided by the founder on 16 Nov 2026. |

## Summary

| Area | Main site | HCG Store | Still blocked by |
| --- | --- | --- | --- |
| Sign-in (HCG Connect) | Issuer and endpoints LIVE-VERIFIED; development client issued; production client NOT ISSUED | Relying party implemented; production packaging for Fly.io in this repository | founder deploys to Fly.io and moves DNS (D1), then the production client |
| `/me`, `/check` | DEPLOYED | STORE: IMPLEMENTED to the deployed contract | nothing for products without editions |
| Edition check (D2) | PROPOSED below | STORE: IMPLEMENTED; refuses to grant without it | main-site D2 build |
| `/library` | PREVIEW | STORE: IMPLEMENTED, display only | publication |
| Product IDs (D3) | 8 products LIVE-VERIFIED; Nexus, Sentinel, Clarity to register | Catalogue mapped to the 8; the 3 stay unmapped | main-site D3 |
| Customer licences (D4) | PROPOSED below | nothing needed | main-site D4 |
| Purchase grants (D5) | PROPOSED below | STORE: IMPLEMENTED (outbox, inert until configured) | main-site D5, credential |
| Releases (D6) | none | Store approval is the release review; the catalogue is generated from it | not a blocker |
| Publishing permissions | `store.publish`, `store.release.approve` PLANNED (16 Nov plan), not created; per-person grants for staff features planned | STORE: IMPLEMENTED: checked per product as central features, fail closed | main-site plan steps 3–4 (founder approval) |
| Executable Maker client | production client ISSUED (`fb9b6edf-2bfc-4b5e-a354-dbb1af697029`, `configured_untested`) | configured for publishing in `fly.toml` (commented until phase 3) | Store deployment and sign-in first |

### What the main site has done since its handoff answer (read 16 Nov 2026, 22:50 UTC)

From the main site's own records (its implementation plan and Executable Maker handoff), not from a live call:
- HCG Executable Maker's **production** HCG Connect client is issued: public, PKCE, loopback callbacks on ports
  47820–47822, status `configured_untested`. Its development client is not issued.
- HCG Store's development client is issued (`af487795-…`), `configured_untested`. No production client.
- **Planned, not built:** feature keys `store.publish` and `store.release.approve` as staff permissions that a purchase can
  never grant; an access-check upgrade so that a staff feature needs an explicit per-member grant (today any member of
  a licensed organisation passes); customer organisations and an edition field (D4, D2); the purchase grant endpoint
  (D5) covering "only the purchased product, edition and features". The plan is awaiting the founder's approval of its
  database changes.
- The plan asks for Executable Maker's capability list and development callback; both live in the Executable Maker
  repository (`docs/SHIP-TO-STORE.md`, `docs/hcg-connect/HANDOFF.md`).

### Requests from HCG Store to the main site (for the founder to approve)

1. **Production Store client** after phase 1 of [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md) (request text there).
2. **Publishing permissions as product features:** create `store.publish` and `store.release.approve` on each product
   that is published through HCG Store (at least `hcg.executable.maker`), and on `hcg.store` for products HCG has not
   registered yet; grant them per person; and make `/check` answer `allowed: false` for an organisation member without
   that person's grant. HCG Store asks `POST /check {org_id, product_id, feature_key}` exactly as deployed.
3. **Two different people** with these grants for at least one product (publisher, approver), so a release can be
   approved for public delivery.
4. **The grant endpoint (D5) with a `features` list:** HCG Store now sends the features an offer includes, e.g.
   `"features": ["download"]`. A purchase never includes a `store.*` feature; the Store refuses such an offer.
5. The `download` feature (D3) and the edition check (D2), before any customer download.

## D1: hosting and the production callback (DECISION; target chosen, not deployed)

**Target: Fly.io**, one always-on machine in Stockholm with a volume, about $4/month. GitHub Pages, the
main site's hosting and Supabase cannot run the Store server. Steps, cost, DNS cutover, rollback and the
production client request: [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md). Until the founder deploys and
moves DNS, the facts below still hold.

The public address stays `store.hakmicapitalgroup.com`.

What HCG Store actually has today:
- The storefront is a static build on GitHub Pages at that address. GitHub Pages cannot run the HCG
  Store server, so sign-in, purchases and downloads are off there.
- The HCG Store server (`server/`) is not hosted anywhere.
- The server is designed to share one origin with the storefront: the browser holds only an HttpOnly,
  `SameSite=Lax` session cookie, and the web app calls `/api/v1/*`, `/auth/*` and `/repo-api/*` on its own
  origin.

So once the server serves the public origin, the production callback is exactly
`https://store.hakmicapitalgroup.com/auth/callback`. The server can serve it directly, or a reverse
proxy can send `/auth/*`, `/api/*` and `/repo-api/*` to it. Until then, that callback must not be
registered, because nothing would answer it. Choosing the host and moving the domain are the founder's
manual steps; no hostname is assumed here.

What can be issued now: the development client with `http://127.0.0.1:8787/auth/callback`.

## Identity: HCG Connect (LIVE-VERIFIED by the main site)

| Field | Value |
| --- | --- |
| Issuer | `https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1` |
| Endpoints | `{issuer}/oauth/authorize`, `{issuer}/oauth/token`, `{issuer}/oauth/userinfo`, `{issuer}/.well-known/jwks.json` |
| Grants, client auth | `authorization_code`, `refresh_token`; public client (`none`) with PKCE S256 |
| Scopes | `openid email profile` (no product scopes exist) |
| Access token | `aud` = `authenticated`; `sub` = central account ID |
| Revocation, end-session | Not offered. Store logout deletes its session and stored tokens; refresh tokens rotate. |

### Development client (16 Nov 2026)

HCG issued `af487795-ead1-4671-8b09-76301762ee2c` (`hcg-store-web-development`, product `hcg.store`):
a public client with callback `http://127.0.0.1:8787/auth/callback`, status `configured_untested`.
The local setup, the guided verifier and what each check proves are in [HCG-CONNECT-DEV.md](HCG-CONNECT-DEV.md).

| Kind | Check | Result |
| --- | --- | --- |
| Configuration (real HCG, from HCG Store's build environment) | Discovery matches the handoff; no revocation or end-session endpoint advertised | Passed |
| Configuration | Signing keys | Passed: 1 ES256 key |
| Configuration | Client registered: authorize with the exact callback | Passed: 302 to HCG's consent page. A random client ID gets `400 oauth_client_not_found` (control). |
| Configuration | Unregistered callback refused | Passed: 400 |
| Configuration | `/me` without a token | Passed: 401 |
| Local server with the real configuration | 1: PKCE S256, state and nonce; 6: forged, stateless and replayed callbacks refused (HCG's token endpoint refused an invalid code with `invalid_grant`); unauthenticated `/api/v1/library` 401; cross-origin logout 403 | Passed |
| Sign-in with a real HCG account | 2: exact callback; 3: code exchange, account matches `/me`; 4: restore after restart and refresh with rotation; 5: logout | **Not run yet.** This needs a person to sign in, in a browser on the same machine as the callback. Run `npm run hcg:dev:verify` on your Mac. |

Do not ask HCG to mark the client verified until the sign-in rows pass.

## Ecosystem API

Base `https://beta.hakmicapitalgroup.com/api/public/ecosystem/v1`. Every call carries the user's HCG
access token (`Authorization: Bearer …`) and is made by the HCG Store server only. Errors are
`{ "error": { "code", "message" }, "api_version": "v1" }`. A route that is not deployed answers with
the site's HTML page.

### `GET /me` (DEPLOYED)

Returns `{ api_version: "v1", user: { id, email }, organisations: [{ org_id, slug, name, kind, org_role }] }`.
401 means the session is dead.

### `POST /check` (DEPLOYED)

Request `{ org_id, product_id, feature_key }`, all required. Response, always 200 for a decision:
`{ api_version, org_id, product_id, feature_key, allowed, layer, reason, verified_at }`. Expired and
revoked licences both answer `allowed: false, reason: "not_licensed"`. There is no licence end date in
the answer. The deployed route has **no edition**; an `edition` field is ignored.

### Edition check (D2, PROPOSED)

Editions are module-scope licences under each product:

| Licence | `scope` | `scope_key` |
| --- | --- | --- |
| One edition | `module` | `edition:<edition key>` |
| All editions, explicitly | `module` | `edition:*` |
| Product-wide (existing licences) | `product` | none |

- `/check` gains an optional `edition`. When it is present, only `edition:<key>` and `edition:*`
  licences count. A product-wide licence does **not** satisfy it, and one edition never satisfies
  another.
- The answer then echoes `"edition": "<key>"` and `"edition_scope": "edition" | "all-editions"`, so the
  caller can see the edition was actually evaluated.
- An edition key the product does not register answers `allowed: false` with
  `reason: "edition_unavailable"`.
- **Compatibility:** without `edition`, `/check` behaves exactly as today, so existing clients (the
  Executable Maker and LifeOS apps) are unaffected. Granting an all-editions licence is an explicit act;
  no product-wide licence is converted automatically.

### `GET /library` (PREVIEW)

Returns `{ api_version, organisations, items: [{ org_id, product_id, product_name, scope, scope_key,
license_type, status, starts_at, ends_at }], revalidate_after_seconds }`. It is for display only and is
never sufficient to serve a file.

### How HCG Store decides access (STORE: IMPLEMENTED, `server/src/entitlements.ts`)

1. `GET /me`; no answer, 401 or anything unrecognised means "access unknown".
2. No organisations means not owned: licences belong to organisations (until D4, ordinary customers
   have none).
3. For each organisation (at most 20), `POST /check` with `feature_key: "download"`. For an edition,
   the request adds the edition's central key, and the answer counts **only** if it echoes that key with
   an `edition_scope`. Until the main site ships D2, every edition check is therefore "access unknown":
   no silent fallback to a product-wide grant.
4. Granted if any organisation answers `allowed: true` for exactly that request. Otherwise "access
   unknown" if any answer was missing or unrecognised, else not owned. 403 for one organisation is
   skipped.
5. Nothing is cached between requests. An edition without a central key is never sent to HCG.

## Product and edition IDs (D3)

| HCG Store product | Central product ID | Status | Edition keys (`edition:<key>`) |
| --- | --- | --- | --- |
| `hcg-terminal` | `hcg.terminal` | LIVE-VERIFIED (main site) | `standard`, `unleashed` |
| `hcg-executable-maker` | `hcg.executable.maker` | LIVE-VERIFIED (main site) | `desktop` |
| `hcg-mail` | `hcg.mail` | LIVE-VERIFIED (main site) | `windows-desktop`, `ios` |
| `hcg-news` | `hcg.news` | LIVE-VERIFIED (main site) | `ios` |
| `hcg-cardx` | `hcg-cardx` (hyphenated, as registered) | LIVE-VERIFIED (main site) | `ios` |
| `hcg-lifeos` | `hcg.lifeos` | LIVE-VERIFIED (main site) | none (no editions) |
| `hcg-one-unleashed` | `hcg.one.unleashed` | LIVE-VERIFIED (main site) | none (no editions) |
| `hcg-reprompter` | `hcg.reprompter` | LIVE-VERIFIED (main site); merged into Clarity | none |
| `hcg-nexus` | not registered | D3: to register | unmapped until registered |
| `hcg-sentinel` | not registered | D3: to register | unmapped until registered |
| `hcg-clarity` | not registered | D3: to register | unmapped until registered |

The catalogue (`catalogue/products.json`) records these as `registry.centralId` and
`editions[].centralEditionKey`. The edition keys are HCG Store's proposal for D3; HCG must register the
same keys. Validation refuses duplicate keys, keys on a product without a central ID, and any offer
that sells an edition without a key.

D3 registers Nexus, Sentinel and Clarity (after checking for duplicates) and a `download` feature with
explicit edition mappings. It does not mark anything released or enable downloads globally. RePrompter
licences are audited and the proposed Clarity migration is shown for approval before anything is
applied; purchase history is kept. HCG Store has no RePrompter purchases: no real offer has ever existed.

## Customer licences (D4, PROPOSED)

One personal customer organisation per buyer:
- created idempotently by the grant service on the first purchase, and reused afterwards;
- the buyer is its only member; it cannot be shared or receive invitations;
- membership gives no staff privileges, and no customer can issue a licence (only the grant service and
  the Owner can).

The migration is additive and is tested on a non-production database before the founder applies it.

## Purchase grants (D5, PROPOSED central endpoint)

`POST https://beta.hakmicapitalgroup.com/api/public/store/v1/entitlements`, called only by the HCG
Store server.

| Rule | Contract |
| --- | --- |
| Auth | `Authorization: HCG-Store-Server <credential>`. Separate test and production credentials, issued and rotated by the Owner, stored only server-side. |
| Environment | Bound to the credential. The body's `environment` must match it or the call is refused (`environment_mismatch`); it can never raise a test call to production. |
| Purchase ID | `store:<provider>:<environment>:<purchase id>:<edition key or "product">`, unique, at most 128 characters |
| Grant | `{ action: "grant", purchase_id, revision, environment, sub, product_id, edition, features, starts_at, ends_at }` (edition key, `*` or null; `features`: the central feature keys the offer explicitly includes, possibly empty, never `store.*`) |
| Revoke | `{ action: "revoke", purchase_id, revision, environment, reason }`, reason `refund`, `chargeback`, `subscription_ended` or `admin` |
| Ordering | Each purchase has a revision that only grows. HCG applies a message only if its revision is newer than the one it holds. |
| Revoked is terminal | A grant never reactivates a revoked purchase. A revoke for a purchase not seen yet is stored as a tombstone, so a delayed grant cannot activate it. |
| Duplicates | Replaying the same message returns the same answer. A revoke of an already revoked purchase answers `409 already_revoked`, which callers treat as done. |
| Several purchases | Each purchase is its own grant. Access is the union of active grants, so revoking one never removes access another purchase gives. |
| Answer | `{ purchase_id, status, revision, starts_at, ends_at, revoked_reason, org_id, replayed }` |
| Errors | `401 credential_refused`, `400 environment_mismatch`, `400 invalid_input`, `404 unknown_account`, `404 unknown_product`, `409 already_revoked`, `503` |
| Triggers | Only verified payment processing, or an Owner's audited administrative action |

HCG Store's side (STORE: IMPLEMENTED, `server/src/grants.ts`, `server/src/payments.ts`):
- **Outbox:** the payment ledger writes the desired state of each purchase in the same transaction that
  applies a signature-verified provider event. No HTTP route, browser or client flag can add one.
- **Delivery:** sent after each processed event and every 30 seconds, with exponential backoff. The
  credential is only ever in the request header: never in the database, an error or a log.
- **Off by default:** inert until both `HCG_STORE_GRANT_API_URL` and `HCG_STORE_GRANT_CREDENTIAL` are
  set. The environment is the server's mode.
- **Out-of-order events:**
  - a refund or dispute that arrives before the completed payment is remembered, so the late completion
    records the purchase as refunded and grants nothing;
  - a stale renewal never shortens a subscription;
  - a stale expiry never ends a renewed one.

## Releases and files (D6, DECISION)

HCG Store stays authoritative for releases and files. Its manual approval (a person with `store.release.approve` for
the product, other than the creator, typing the version, in the hash-chained audit) is the release review; the public
`catalogue/releases.json` entries for those releases are generated from it (`npm run releases:sync`), not reviewed a
second time. Central HCG stays authoritative for identity, licences and permissions. No second release-approval
authority is created.

On the main site's §9 listing D6 as a blocker: it is not one. Store-managed artifacts are permitted
(its §7). The end-to-end download test is blocked by other things:
- D2 shipped (the edition check);
- D3 (the `download` feature, granted to the test licence);
- a founder-supplied test file in protected storage;
- the launch switch.

A test licence the Owner grants to a test organisation can exercise downloads before D4 and D5 exist.
Only the purchase items of the checklist need D4 and D5.

## Verification

| What | How | Result |
| --- | --- | --- |
| Ecosystem client: deployed request shape, organisations, no fallback for editions, all-editions licence, wrong-edition answers, 401/403/429/503, malformed answers, `/library` | `server/test/ecosystem.test.ts` against a mock of the contract above | 12 passed |
| Grants: namespaced IDs, bound environment, edition keys, duplicates, refund revoke, terminal revoke, refund before completion, two purchases, stale renewal and expiry, backoff, no credential stored | `server/test/grants.test.ts` | 10 passed |
| Catalogue: only confirmed central IDs, unique edition keys, no keys without a product ID | `src/domain/catalogue.test.ts` | passed |
| Everything else | `npm run check` (174 tests), `npm run test:e2e` (44) | passed |
| Anything against live HCG | not possible from the build environment | not run |

## Manual steps that stay with the founder

- Deploy the Store server to Fly.io and move `store.hakmicapitalgroup.com` (D1,
  [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md)); then request the production client.
- Approve the main-site plan's permission and access-check changes, and have HCG grant the publishing permissions
  to two different people.
- Apply the D2–D5 main-site migrations to production after their non-production tests pass.
- Issue and activate the grant credentials (test first) and set them in the Store server's secret store.
- Publish `/library` and the new routes; enable the `download` feature per product; launch.
