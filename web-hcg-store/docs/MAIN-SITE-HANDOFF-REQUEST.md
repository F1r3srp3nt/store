# HCG Store ↔ Main Site Integration Handoff Request

16 November 2026 · HCG Store development, for founder review

> **Answered.** The main site replied on 16 November 2026 and the founder decided D1–D6. The current contracts, decisions and status are in [MAIN-SITE-INTEGRATION.md](MAIN-SITE-INTEGRATION.md); this request is kept as the record of what was asked.

HCG Store is ready to connect to the central HCG systems, but it cannot until the main site confirms five things: a login client, the Ecosystem API contracts, central product IDs, a grant/revoke endpoint for purchases, and how approved releases are recorded. This document asks for exactly those, nothing more.

## Why this request exists

We were told the central integration is now implemented in the main-site project. We could not find that implementation, so we cannot connect HCG Store to it without guessing, and we will not invent endpoints.

What we inspected on 16 November 2026:

| Source | What it is | Finding |
| --- | --- | --- |
| HCG ONE repository (private) | HCG ONE web and iOS clients; CardX identity report | A client of the main site, last commit 27 October. No registry, entitlement or licence server code. Its home page says billing is not connected. |
| HCG Server repository (private) | Device and storage host agent | Its HCG Connect package is an adapter boundary only: "no endpoints assumed". |
| An older HCG website test repository (private) | Trading terminal web app (8 October) | Unrelated. |
| HCG Executable Maker `docs/hcg-connect/HANDOFF.md` (11 November) | Live-verified notes on HCG Connect | Ecosystem routes exist (401 without a token); response bodies still marked "NEEDS HCG". |
| `beta.hakmicapitalgroup.com`, Supabase auth host | Live backend | Not reachable from our build environment, so nothing was verified live. |

The main site's server code (the code behind `beta.hakmicapitalgroup.com/api/public/*` and its database migrations) is not in any repository we can reach. Either share that repository or answer the requests below.

## What HCG Store already has

The Store side is built and tested against a mock HCG Connect and test-mode payments; only the three central pieces on the right are missing.

![HCG Store keeps the tokens; HCG decides every access. The Store web app (HttpOnly cookie only) and HCG Repo / Sileo call the HCG Store server, which does PKCE sign-in, sessions, refresh and revocation checks, one access decision, protected file delivery, a test-mode checkout ledger and verified payment events, with downloads off until launch. A test-mode payment provider sends it signed events. The server calls HCG Connect for sign-in (needs a Store client ID) and the Ecosystem API for checks (needs confirmed bodies); the grant/revoke API it would call after paid events is not published yet.](images/main-site-handoff-architecture.png)

The browser holds only an HttpOnly session cookie; the Store server keeps the HCG tokens and asks HCG before every protected action. Downloads and live payments stay off until the founder approves launch, whatever this integration enables.

| Store piece | Where (HCG Store repo, `web-hcg-store/`) |
| --- | --- |
| HCG Connect relying party: PKCE, ID- and access-token checks, refresh rotation, dead-session detection | `server/src/hcg-connect.ts` |
| Sessions, re-check with HCG before protected actions, logout | `server/src/sessions.ts` |
| Entitlement check against the Ecosystem API (read-only) | `server/src/entitlements.ts` |
| One access decision for the website, HCG Repo and Sileo | `server/src/access.ts` |
| Test-mode checkout, signed events, idempotent ledger | `server/src/payments.ts` |
| Protected delivery; Sileo payment-provider API | `server/src/app.ts`, `server/src/sileo.ts` |

## Request 1: register HCG Store as an HCG Connect client

Issue one new public client for "HCG Store (web)" through the ERP App integrations workflow ("Inspect registrations", then "Issue or reuse login client"). Do not reuse another app's client.

| Setting | Value |
| --- | --- |
| Client type | Public: `token_endpoint_auth_method: none`, no secret |
| Grants | `authorization_code`, `refresh_token` |
| PKCE | S256 |
| Scopes | `openid email profile` (identity only; they grant no product access) |
| Access-token audience | `authenticated` |
| Name on the consent page | HCG Store |
| Logout return URL | None |
| Redirect URI, local development | `http://127.0.0.1:8787/auth/callback` |
| Redirect URI, production | `https://<Store server host>/auth/callback` |

The production redirect must point at the HCG Store server, not the static site: `store.hakmicapitalgroup.com` is currently served by GitHub Pages, which cannot run the server. Tell us which host the Store server will use (for example `store.hakmicapitalgroup.com` moved to the server, or a separate host), and register that exact URI.

Record the binding as `configured_untested` until the acceptance in this document passes.

**Send back:** the client ID (not a secret) and the registered redirect URIs.

## Request 2: confirm the Ecosystem API contracts

The routes under `https://beta.hakmicapitalgroup.com/api/public/ecosystem/v1` answer 401 without a token, but their bodies are unconfirmed. HCG Store calls them with the user's HCG access token (`Authorization: Bearer …`) from its server only.

| Route | What HCG Store needs it for | What HCG Store assumes today (please confirm or correct) |
| --- | --- | --- |
| `GET /me` | Show the signed-in account; confirm the session is still live | Unconfirmed; not called yet |
| `GET /features?org=&product=` | List what the user owns, for the library page | Unconfirmed; the library shows "cannot confirm" until a list route exists |
| `POST /check` | Decide each protected action (view access, download) | Request `{ "product_id", "edition", "feature_key": "download" }`; response `{ "allowed": true\|false, "licence": { "ends_at" } }` |

For each route, please send:

1. The exact request body and query parameters, including whether `org_id` is required for personal accounts.
2. The exact response body for: granted, not granted, licence expired, licence revoked, and unknown product.
3. The status codes and error bodies (401, 403, 404, 429, 5xx).
4. Whether an expired or revoked entitlement is reported as `allowed: false` or as an error, and whether the response says which.
5. A route that lists every product and edition the user owns, if `/features` is not it.

HCG Store treats any answer it does not recognise as "access unknown", never as a grant.

## Request 3: confirm central product and edition IDs

Every HCG Store product still has a provisional ID; only `hcg.executable.maker` has been reported as a central ID. HCG Store keeps its own IDs in its URLs and maps each one to the central ID you confirm. Fill in the right-hand columns.

| HCG Store product ID | Name | Store edition IDs | Central product ID | Separate entitlement per edition? |
| --- | --- | --- | --- | --- |
| `hcg-terminal` | HCG Terminal | `standard`, `unleashed` (jailbreak package) |  |  |
| `hcg-nexus` | HCG Nexus | `app`, `jailbreak` (jailbreak package) |  |  |
| `hcg-sentinel` | HCG Sentinel | `app` |  |  |
| `hcg-executable-maker` | HCG Executable Maker | `desktop` | `hcg.executable.maker`? (its repo also uses `executable-maker`) |  |
| `hcg-clarity` | HCG Clarity | `macos-desktop` |  |  |
| `hcg-mail` | HCG Mail | `windows-desktop`, `ios` |  |  |
| `hcg-news` | HCG News | `ios` |  |  |
| `hcg-cardx` | HCG CardX | `ios` |  |  |
| `hcg-lifeos` | HCG LifeOS | none yet |  |  |
| `hcg-one-unleashed` | HCG ONE: Unleashed | none yet |  |  |
| `hcg-reprompter` | HCG RePrompter (merged into Clarity) | none | Should old RePrompter entitlements count for Clarity? |  |

Also confirm:

- the `edition` value `/check` expects (our edition ID, a central edition ID, or none);
- that LifeOS realm keys (`hcg.mail`, `hcg.lifeos`, …) are not product IDs, as we assume;
- that HCG roles never grant product access by themselves, as every HCG app repository states.

## Request 4: a server-to-server grant and revoke endpoint

No HCG endpoint can record a purchase today, so a payment in HCG Store cannot become an HCG entitlement. Please publish one that only the HCG Store server can call.

HCG Store calls it only after its own server has verified the payment provider's signed event; a browser returning from checkout never triggers it. Requirements:

- **Credentials:** a dedicated server credential for HCG Store, held only in the Store server's secret store, never reachable from browsers. Tell us how it is sent (header name and scheme).
- **Grant:** account (HCG `sub`), central product ID, edition, licence start and end (or none for perpetual), and a purchase ID.
- **Revoke:** the same purchase ID, with a reason: `refund`, `chargeback`, `subscription_ended` or `admin`.
- **Idempotent per purchase ID:** sending the same grant or revoke twice changes nothing and returns the same result.
- **Response:** the resulting entitlement state, so HCG Store can record exactly what HCG holds.
- **Errors:** unknown account, unknown product, already revoked, and credential refused, each with its own code.

Until this exists, HCG Store keeps purchases in test mode only and grants nothing centrally.

**Send back:** the endpoint, request and response bodies, error codes, and how the credential is issued.

## Request 5: approved releases and artifacts

HCG Store shows a release as available only when HCG has approved it and a real file exists; today no product has one, so every product shows Coming soon. Please tell us where release approval lives.

1. Does the central product registry record approved releases? If so, which fields: version, build, channel (stable, beta, test), platform, approval date, approver.
2. Is there a read API for them, and what does it return for a draft or test release?
3. Where are release files stored, and how should HCG Store fetch one for a signed-in, authorized user without exposing a public link? (HCG Store streams files from protected storage itself; it never publishes download URLs.)
4. Are SHA-256 checksums and code-signing details recorded with each artifact?
5. If the registry does not hold releases, confirm that HCG Store's own release file (`catalogue/releases.json`, reviewed by the founder) stays the place where releases are approved.

For the end-to-end test we need one **draft or test release** of HCG Executable Maker, marked so that it can never appear as a public release.

## Test setup for the end-to-end run

One product is tested end to end, in payment test mode, with no real charge. The test product is **HCG Executable Maker (edition desktop)**, the only product with a reported central ID.

| Item | Who provides it | Notes |
| --- | --- | --- |
| Test account A, the owner | Main site | Holds a test entitlement for HCG Executable Maker, edition desktop |
| Test account B, not an owner | Main site | No entitlement; used to prove refusals |
| Test entitlement for account A | Main site | Granted centrally; later revoked, and one set to expire, during the test |
| Draft or test release with one small test file | Main site or founder | Never shown as a public release |
| Grant API credential (test) | Main site | Entered through the environment's secure credential prompt, never pasted in chat |
| Network access from the build environment to `beta.hakmicapitalgroup.com` and `qggdyzoydveafkmjgkpq.supabase.co` | Store owner approves in the environment settings | Both are blocked today |

Account passwords are not shared with HCG Store or its developers: sign-in happens through HCG Connect in a browser.

## Acceptance checklist

The integration counts as done only when each item below passes against live HCG; tests against a mock do not count. HCG Store ticks these off and reports the evidence.

- [ ] **Sign-in, restore, logout:** account A signs in through HCG Connect; the session survives a Store server restart; logout ends it on HCG Store.
- [ ] **Registry mapping:** HCG Executable Maker (edition desktop) resolves to its confirmed central ID; no Store product ID changes.
- [ ] **Library:** account A's library shows the test entitlement; account B's shows none.
- [ ] **Downloads authorized by the server:** signed out, the test file is refused; account B is refused; account A gets the file only through the Store server.
- [ ] **Revoked or expired access:** after HCG revokes the entitlement, and separately after it expires, account A is refused on the next request.
- [ ] **Payment from verified events only:** a test-mode purchase grants access only after the signed provider event and the grant call; returning from checkout alone grants nothing; a replayed event changes nothing.
- [ ] **Releases reflect real artifacts:** only the draft release's real file is offered to account A; every other product still shows Coming soon.

After it passes, mark the registry binding `verified_production`. Downloads and live payments still stay off until the founder approves launch.

## Not part of this request, and how to reply

Please do not, as part of this request:

- create real customer accounts, grant licences to real customers, or turn on billing;
- reuse another app's HCG Connect client;
- give HCG Store any admin or service-role key, or anything a browser could read.

**How to reply:** answer in this document (inline or in comments), or share the main site's server repository with the HCG Store developers. Send the grant API credential only through the secure credential prompt. Once the answers are in, HCG Store will connect to the confirmed contracts, run the checklist above in test mode, and open a pull request for founder review without merging it.
