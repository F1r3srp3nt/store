# HCG ERP and HCG Connect integration

Nothing in this repository registers clients with HCG, changes HCG settings or connects to live HCG
services. Items marked **NEEDS HCG** are for the founder and the main HCG site to decide or issue.

## 1. Responsibilities

| Concern | Authority |
|---|---|
| Identity: sign-in, sessions | **HCG Connect** (main HCG site) |
| Products, central product IDs, approved releases | **HCG ERP** product registry |
| Entitlements, licences, App Access | **HCG ERP** (`app_entitlements` and related records) |
| Product discovery, checkout, purchase history, owned-product library | **HCG Store** (this repository: web app and server) |
| Jailbreak package delivery | **HCG Repo** (see [HCG-REPO.md](HCG-REPO.md)) |

HCG Store holds no user accounts or roles of its own. People are identified by their HCG `sub`.

## 2. What exists centrally (inspected 15 November 2026, read-only)

The main HCG site's source code is not in any reachable repository. These facts come from the handoff
documents other HCG apps wrote after observing the live systems: HCG LifeOS
`docs/HCG-CONNECT-LIFEOS-HANDOFF.md` and HCG Executable Maker `docs/hcg-connect/HANDOFF.md`, which are
marked LIVE-VERIFIED.

- **HCG Connect is live:** the OAuth 2.1 server of HCG's Supabase Auth project. Issuer
  `https://qggdyzoydveafkmjgkpq.supabase.co/auth/v1`, with `/oauth/authorize`, `/oauth/token`,
  `/oauth/userinfo` and `/.well-known/jwks.json` (one ES256 key). It supports public clients, PKCE
  S256, and the `authorization_code` and `refresh_token` grants.
- **Tokens:** the ID token's `aud` is the client ID. The access token's `aud` is `authenticated`, plus
  a signed `client_id`. There is **no revocation or end-session endpoint**. Dead refresh tokens return
  `refresh_token_not_found`, `refresh_token_already_used`, `session_not_found` or `session_expired`.
- **Clients:** HCG registers them centrally through the ERP App integrations workflow. Each app needs
  its own; another app's client must not be reused. **HCG Store has no client yet.**
- **Entitlements:** the ERP has `app_applications`, `app_entitlements` (with status, `expires_at`,
  `revoked_at`) and `app_effective_entitlements`. The routes
  `https://beta.hakmicapitalgroup.com/api/public/ecosystem/v1/{me,features,check}` exist (401 without a
  token), but their response bodies are unconfirmed. **No grant endpoint for purchases is published.**
- **Product IDs:** only `hcg.executable.maker` is reported as live, and even that repository also uses
  `executable-maker`. No other central IDs were found. The LifeOS "realm keys" (`hcg.mail`,
  `hcg.lifeos`, …) are gamification realms, not product IDs. The catalogue now labels them as such.
- **Payments:** none exist (see [PAYMENTS.md](PAYMENTS.md)).
- **Role policy:** every app repository states that HCG roles do not grant product access. The ERP
  has a per-application "company auto-grant" switch that produces ordinary entitlements.

## 3. What HCG Store implements

| Piece | Where |
|---|---|
| HCG Connect relying party (server side): PKCE, ID-token and access-token verification, refresh rotation, dead-session detection | `server/src/hcg-connect.ts` |
| Sessions, re-confirmation with HCG before protected actions, logout | `server/src/sessions.ts` |
| Entitlement authorities: `hcg-ecosystem` (read-only `POST /check`, proposed body) and `test-ledger` (test mode only) | `server/src/entitlements.ts` |
| One access decision for the website, HCG Repo and Sileo | `server/src/access.ts` |
| Test-mode checkout, signed events, idempotent ledger | `server/src/payments.ts` |
| Protected delivery and the Sileo payment-provider API | `server/src/app.ts`, `server/src/sileo.ts` |
| Account state in the browser (no tokens) | `src/account/` |

The browser bundle no longer contains any HCG Connect settings. The earlier `VITE_HCG_CONNECT_*`
variables were removed.

## 4. NEEDS HCG: ready-to-paste request for the main HCG site

The full, current request (16 November 2026) is [MAIN-SITE-HANDOFF-REQUEST.md](MAIN-SITE-HANDOFF-REQUEST.md): login client, Ecosystem API contracts, central product IDs, a grant/revoke endpoint, release approval, test setup and the acceptance checklist. The summary below is kept for reference.

> Register **HCG Store (web)** as an HCG Connect client, using the ERP App integrations workflow
> ("Inspect registrations" → "Issue or reuse login client"). Do not reuse another app's client.
>
> - Client type: public (`token_endpoint_auth_method: none`), no secret. Grants `authorization_code`
>   and `refresh_token`. PKCE S256.
> - Redirect URIs (exact):
>   - `https://store.hakmicapitalgroup.com/auth/callback` (when the domain is live);
>   - `https://<preview-host>/auth/callback` (one approved preview host);
>   - `http://localhost:8787/auth/callback` (local development).
> - Scopes `openid email profile`; access-token audience `authenticated`; no logout URL.
>   HCG Store's server keeps the tokens; the browser holds only an HttpOnly session cookie.
> - Name on the consent page: "HCG Store".
>
> For entitlements, please:
>
> 1. Confirm central product IDs for: HCG Terminal (editions `standard`, `unleashed`), HCG Nexus
>    (`app`, `jailbreak`), HCG Sentinel, HCG Executable Maker (`hcg.executable.maker` or
>    `executable-maker`?), HCG Mail (`windows-desktop`, `ios`) and HCG Clarity.
> 2. Confirm the `POST /api/public/ecosystem/v1/check` body and response. HCG Store sends
>    `{ product_id, edition, feature_key: "download" }` and reads `{ allowed, licence.ends_at }`.
> 3. Publish a server-to-server **grant/revoke** endpoint that HCG Store's server can call after a
>    verified payment, refund or subscription change. It must be idempotent per purchase ID, use its own
>    credentials, and never be reachable from browsers.
> 4. Decide whether editions are separate entitlements, which they are in HCG Store's model.
>
> Do not create accounts, grant licences or enable billing as part of this.

HCG Store needs back: the client ID (not a secret), the confirmed product IDs, the API contracts, and
the server credential for the grant API (stored only in the Store server's secret store).

## 5. Acceptance after issuance

Run the acceptance list in [ACCESS.md](ACCESS.md#acceptance-list) against live HCG, with:
- `HCG_CONNECT_*` set to the issued client;
- `HCG_STORE_ENTITLEMENT_AUTHORITY=hcg-ecosystem`;
- two test accounts (owner and non-owner) and one test entitlement granted by HCG.

Payments stay disabled until a provider is approved. Downloads stay disabled until the founder
approves launch.

## 6. Catalogue provider (unchanged)

The ERP catalogue provider (`src/providers/erp.ts`) still reads a public, read-only catalogue endpoint
when one exists (`VITE_CATALOGUE_PROVIDER=hcg-erp`, `VITE_HCG_ERP_CATALOGUE_URL`). The proposed endpoint
shape is the schema in `src/domain/schema.ts`. It now includes `editions` and `hcgRepo`, and never
contains download URLs.
