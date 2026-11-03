# HCG ERP and HCG Connect integration path

Status: **preparation only.** Nothing in this repository connects to, registers with or changes any
central HCG service. Every item marked **PROPOSED** is for the founder to accept, change or reject.

## 1. Governance (unchanged by this project)

| Concern | Authority |
|---|---|
| Product registry, approved release metadata | HCG ERP / Executive Control Center |
| Organisations, licences, App Access and permissions, administrative authorisation | HCG ERP / Executive Control Center |
| Identity (sign-in, sessions, revocation) | HCG Connect / Auth |
| This storefront | Reads public data. Holds no user database, role store or permissions |

## 2. What was inspected

| Source | Finding |
|---|---|
| `docs/hcg-auth-contract.md`, `docs/hcg-authorization-contract.md`, `docs/hcg-connect/handoffs/` | **Not found** in this repository or in the HCG repositories reachable from this session (HCG-One, HCG-LifeOS, HCG-Mail, HCG-News, hcg-cardx, HCG-Executable-Maker, HCG-RePrompter, HCG-ONE-UNLEASHED, HCG-Terminal). The main-site (ERP) repository was not available. |
| `HCG-LifeOS/docs/HCG-CONNECT-LIFEOS-HANDOFF.md` | A preparation-only handoff for a *native* client. It records the browser login page `https://beta.hakmicapitalgroup.com/auth`, states that it is "a web page, not a documented native protocol", and proposes Authorization Code + PKCE **pending approval**. |
| `HCG-One/HCG-CARDX-AUTH-INTEGRATION-REPORT.md`, `hcg-cardx` contract | Existing native apps use the central identity backend, and some use an OAuth client registered **for CardX**. |

Conclusions applied in the code:

- **No protocol is assumed** from the existence of a login page.
- **No other app's OAuth client, redirect URI or keys are reused.** HCG Store needs its own reviewed
  registration.
- No identity-provider URL, project reference or public key from other apps is embedded in this project.

## 3. What exists in HCG Store

| Piece | Where | Behaviour |
|---|---|---|
| `CatalogueProvider` interface | `src/providers/types.ts` | Read-only `load()` returning a validated catalogue or an explicit error |
| Local provider | `src/providers/local.ts` | Bundled seed data, validated at load and at build |
| HCG ERP provider | `src/providers/erp.ts` | `GET` of a public HTTPS endpoint, `credentials: "omit"`, 10 s timeout, 5 MB cap, full schema validation. **No silent fallback** to seed data |
| HCG Connect config | `src/integrations/hcg-connect/config.ts` | Parses 10 public settings. States: `not-configured` / `invalid` (https, redirect-origin and approval checks) / `ready` |
| HCG Connect adapter | `src/integrations/hcg-connect/adapter.ts` | Tracks configuration, authentication and App Access separately. The only implementation **refuses every operation**, makes **no network requests**, stores no tokens and never reports a signed-in user |
| Account & Connections page | `/account` | Shows "HCG Connect not configured", the missing settings, a disabled sign-in button, catalogue source and delivery limitations |

Tests prove the unconfigured, partially configured and fully configured adapter all make zero `fetch`
calls and never report a session (`src/integrations/hcg-connect/hcg-connect.test.ts`).

Public catalogue browsing and public downloads work without any login.

## 4. Configuration handoff

All values are **public** (embedded in the bundle). A client secret must never be configured. The
build refuses `VITE_` names containing SECRET/TOKEN/PASSWORD/PRIVATE/SERVICE_ROLE/API_KEY.

| Variable | Needed from central HCG |
|---|---|
| `VITE_CATALOGUE_PROVIDER` | `hcg-erp` once the endpoint below exists |
| `VITE_HCG_ERP_CATALOGUE_URL` | Public read-only catalogue endpoint per environment |
| `VITE_HCG_CONNECT_CONTRACT_VERSION` | Agreed contract version |
| `VITE_HCG_CONNECT_AUTHORIZATION_ENDPOINT` | Per environment (beta / production) |
| `VITE_HCG_CONNECT_TOKEN_ENDPOINT` | Per environment |
| `VITE_HCG_CONNECT_REVOCATION_ENDPOINT` | Per environment |
| `VITE_HCG_CONNECT_APP_ACCESS_ENDPOINT` | Per environment |
| `VITE_HCG_CONNECT_CLIENT_ID` | A **public** client registered specifically for HCG Store |
| `VITE_HCG_CONNECT_REDIRECT_URI` | Must be on the origin serving the build (checked at runtime) |
| `VITE_HCG_CONNECT_SCOPES` | Approved scopes |
| `VITE_HCG_CONNECT_APP_IDENTIFIER` | HCG Store's ID in the App Access registry |
| `VITE_HCG_CONNECT_APPROVED_BY_FOUNDER` | `true` only after approval |

Even with every value set, sign-in stays disabled until a **reviewed protocol implementation** is added
behind `HcgConnectAdapter`.

## 5. PROPOSED central changes (founder review required; none were applied)

1. **Product registry read endpoint.** A public, read-only, cacheable endpoint, e.g.
   `GET https://<erp-host>/api/public/store/v1/catalogue`, returning
   `{ "schemaVersion": 1, "products": [...], "releases": [...] }` with the item schema in
   `src/domain/schema.ts`, *or* a documented ERP schema that HCG Store maps in a new provider. Only
   approved, public releases are included. CORS allows the store origins (localhost for development, the
   preview host, and later the production host).
2. **Registry IDs.** Assign central IDs for the 14 products and record them as `registry.centralId`.
   Keep the provisional `id`s as aliases, or tell HCG Store which central IDs supersede them.
3. **Naming decisions.**
   - Does `hcg.one` refer to HCG ONE or HCG ONE: Unleashed? Should HCG ONE (iOS/web) be listed?
   - Confirm the categories for HCG RePrompter, HCG Terminal and HCG Virtualisation (provisionally
     *HCG Development Tools*).
   - Describe HCG Studio, Jailbreak Directory, Jailbreak Unleashed, Office Suite and Analytics & Measure.
4. **Release approval workflow.** Who approves a release, and how ERP records version, build, channel,
   artifacts, SHA-256 and signing evidence.
5. **HCG Connect web client for HCG Store**, if and when sign-in is wanted:
   - protocol and flow (for a browser SPA, typically Authorization Code + PKCE with a public client; to be
     confirmed by central HCG);
   - a **new** public client registration for HCG Store (not CardX's or another app's);
   - allowed redirect URIs: `http://localhost:5173/account/callback` (development),
     `https://<preview-host>/account/callback` (preview) and later
     `https://store.hakmicapitalgroup.com/account/callback` (production, only when the domain is live);
   - scopes, token lifetimes, refresh rotation and revocation semantics;
   - an App Access read endpoint returning status (granted / denied / revoked / unlicensed), organisation,
     centrally defined permission names, `validUntil` and reason.
6. **Server-side enforcement.** Any future restricted operation (licensed downloads, organisation-only
   releases, administration) is authorised by an HCG backend, never by browser checks.
7. **Private delivery.** If licensed downloads are needed, a backend that issues short-lived signed URLs
   after an App Access check. This is separate from public Dropbox links.

## 6. Paste-ready prompt for the main-site / ERP session

> You are working on the HCG main site (ERP / Executive Control Center), which owns the HCG product
> registry, approved release metadata, organisations, licences, App Access and identity. Prepare, **but do
> not deploy or enable**, the central side for **HCG Store**, the public web storefront (repository
> `F1r3srp3nt/store`, directory `web-hcg-store/`).
>
> Constraints: do not change existing auth settings, RLS policies, roles, permissions or OAuth clients
> automatically. Write every change as a reviewable diff or migration, with a summary for founder approval.
> Do not reuse another app's OAuth client. Do not deploy.
>
> Produce:
> 1. A proposal for a public, read-only catalogue endpoint that returns approved products and releases
>    (shape in HCG Store `src/domain/schema.ts`, or a documented ERP schema), including CORS for
>    `http://localhost:5173` and the preview host.
> 2. Central IDs for: HCG LifeOS, HCG Mail, HCG ONE: Unleashed, HCG News, HCG Executable Maker,
>    HCG RePrompter, HCG Studio, HCG CardX, HCG Terminal, HCG Virtualisation, HCG Jailbreak Directory,
>    HCG Jailbreak Unleashed, HCG Office Suite, HCG Analytics & Measure.
> 3. How the current login at `https://beta.hakmicapitalgroup.com/auth` works (provider, protocol, session,
>    token format), and which browser-SPA flow the stack supports.
> 4. A proposed public-client registration for HCG Store (client ID, redirect URIs, scopes, lifetimes,
>    revocation) and an App Access read endpoint. Mark everything "pending founder approval".
> 5. Values or "TBD" for every variable in HCG Store's `.env.example` HCG Connect section.

## 7. Implementation steps once approved

1. Add the approved endpoint to the environment (`VITE_CATALOGUE_PROVIDER=hcg-erp`,
   `VITE_HCG_ERP_CATALOGUE_URL=…`). The CSP `connect-src` is extended automatically at build time.
2. If the ERP schema differs, write a mapping provider. Keep IDs stable.
3. Implement the approved sign-in flow behind `HcgConnectAdapter` with tests mirroring the LifeOS
   acceptance list: no config → zero requests; revoked → signed out; no privilege inference from email or
   name.
4. Security review, then founder approval, before enabling `canSignIn`.
