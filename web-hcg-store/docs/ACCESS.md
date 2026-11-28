# Access, ownership and protected delivery

**Release policy (in force):** no tool is downloadable or installable until HCG Connect sign-in and
server-side access enforcement are implemented, verified against HCG's live systems, and the founder
approves launch. Until then every product page, the library and HCG Repo say
**"Downloads are not available yet."**

**Exception in force (founder-approved, 27 Nov 2026): HCG Mail.**
- HCG Mail's published, public, free releases download **without an HCG account**
  (`HCG_STORE_ANONYMOUS_FREE_PRODUCTS=hcg-mail`).
- Only HCG Mail can be approved, published or delivered (`HCG_STORE_PUBLICATION_PRODUCTS=hcg-mail`).
- Licensed and paid downloads, and payments, stay off.
- Details and security implications: [RELEASE-HCG-MAIL-1.0.0-beta.1.md](RELEASE-HCG-MAIL-1.0.0-beta.1.md).

## Who decides what

| Decision | Owner | Where HCG Store stands |
|---|---|---|
| Identity: who someone is | **HCG Connect**, the live OAuth 2.1 server of HCG's Supabase Auth project | HCG Store is a relying party. It has no user table and no roles; people are identified only by their HCG `sub`. |
| Ownership: entitlements and licences | **HCG** (ERP App Access: `app_entitlements` and related records) | HCG Store asks an *entitlement authority* on every protected request. It never decides ownership itself. |
| Products and central product IDs | **HCG ERP** product registry | The catalogue is provisional. `registry.centralId` stays empty until HCG confirms the ID, and **a product without a central ID can never be owned**. |
| Prices and what a purchase grants | HCG Store server's **offers file** (`server/data/offers.json`) | Empty: HCG has set no price. Only server-side values are used. |
| Purchase history, checkout and payment events | **HCG Store server** | Implemented; only a TEST payment provider exists (see [PAYMENTS.md](PAYMENTS.md)). |
| Package distribution for jailbreak apps | **HCG Repo** | Product pages link both ways. HCG Repo refuses to publish non-public packages. |

HCG account roles (owner, admin, staff) **never** imply ownership of a product. The Store never reads
roles, and a test proves that an `admin` role grants nothing. HCG's ERP can grant employees access
through its own per-application auto-grant setting. That grant would arrive as a normal entitlement,
which is the central policy deciding.

## Architecture

```
Browser ── HttpOnly session cookie ──▶ HCG Store server ──▶ HCG Connect (sign-in, token refresh)
   │ (no HCG tokens in the browser)       │  ├─▶ Entitlement authority (HCG ecosystem API | TEST ledger)
   │                                      │  ├─▶ Payment provider (TEST only; webhooks are signed)
   │                                      │  └─▶ Private file storage (never public)
HCG Repo page ── same-site fetch ─────────┘
Sileo ── Store-issued repo token in POST bodies ──▶ /api/sileo/v1/*
```

- **Sign-in:** authorization code + PKCE S256, run by the server. It verifies the ID token (ES256 via
  JWKS, issuer, audience = client ID, nonce, expiry) and the access token (issuer, signature, subject,
  `client_id`).
- **Session:** an opaque 256-bit session ID in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax).
  The server stores only its SHA-256, plus the HCG refresh and access tokens sealed with AES-256-GCM.
- **Session restoration:** every page load asks `GET /api/v1/session`. The cookie persists for up to
  30 days, with a 7-day idle limit. A stale central confirmation is renewed before protected actions.
- **CSRF:** cookie-authenticated changes (checkout, logout, test checkout) require the Store's own
  `Origin`.
- **Caching:** every API and file response is `Cache-Control: private, no-store` with
  `Vary: Cookie, Authorization, Origin`, so a CDN or proxy cannot serve one person's response to
  another. Only the hashed static assets under `/assets/` are publicly cacheable, and they contain no
  account data.

## Logout, expiry and revocation (as implemented and tested)

| Event | Effect |
|---|---|
| **Sign out of HCG Store** | The session ends immediately on the server. The cookie is cleared, a copied cookie stops working, and every HCG Repo/Sileo token created from that session is revoked. It does **not** sign the person out of other HCG apps, because HCG Connect has no end-session or revocation endpoint. |
| **Idle 7 days / absolute 30 days** | The session ends and the person must sign in again. |
| **Central session ended** (signed out elsewhere, removed, refresh token dead) | The next protected action after the re-check window (`HCG_STORE_SESSION_RECHECK_SECONDS`, default **60 s**) refreshes with HCG. HCG reports `session_not_found` (or a similar code), so the Store session ends and the request is refused. Inside that window, the last confirmation stands. |
| **HCG Connect unavailable** | Protected actions answer "could not be checked right now" (503). An outage is never shown as a denial or a grant, and the session is kept. |
| **Entitlement revoked** (refund, dispute, expiry, administrator) | Takes effect on the **next request**. Entitlements are checked live on every download, every access check and every short-lived URL use, with no caching. |
| **Short-lived Sileo URL** | Valid for `HCG_STORE_DOWNLOAD_URL_TTL_SECONDS` (default **120 s**), HMAC-signed and bound to one session and one file. Using it re-checks the session and the entitlement, so revocation applies even within the 120 s. A file already transferred cannot be recalled. |

## Protected artifacts and storage audit

- **Public catalogue:** `catalogue/*.json` can no longer contain a download URL. The schema rejects
  `download` and `url` fields on artifacts. The earlier Dropbox shared-link model was removed: shared
  links are bearer URLs, and anyone who has one can download the file.
- **Built website (`dist/`):** contains no binaries. A test fails if a `.deb/.ipa/.dmg/.pkg/.exe/.msi/
  .apk/.zip` file or a Dropbox link appears in the build.
- **Private storage:** files live in `HCG_STORE_ARTIFACT_STORAGE_DIR`, outside the static root, and are
  served only by `GET /api/v1/downloads/<id>` after these checks, in order:
  1. session (re-confirmed with HCG);
  2. the launch switch;
  3. the entitlement for that product **and edition**;
  4. delivery approval of that exact file;
  5. an approved release.

  Path traversal is refused, and tested.
- **HCG Repo (GitHub Pages):** everything it publishes is public. Its validator now refuses any
  package whose product is `login-required` or `paid`, and any unmapped `com.hakmicapitalgroup.*`
  package. Under the current policy, no HCG package can be published there. The repository is empty
  today.
- **GitHub release assets:** CI artifacts in the product repositories (HCG Nexus `.deb`, HCG Clarity
  DMG) are workflow artifacts. They are visible only to people with access to that repository and
  expire automatically; they are not release assets. HCG Mail's and HCG Executable Maker's workflows *can*
  create public GitHub pre-releases on a `v*` tag. **Do not use public GitHub releases for login-gated
  or paid builds.** Use private storage behind the Store.
- **Package metadata:** HCG Repo pages and `Packages` contain no credentials. The Sileo token is
  Store-issued, revocable, and sent only in POST bodies. It is never put in the APT source URL.

## Release publishing (Ship to Store)

Releases can be uploaded from HCG Executable Maker as private drafts and approved manually in the Store; see
[PUBLISHING.md](PUBLISHING.md). It is off by default and does not change the launch conditions below: approved public
files are still delivered only through the gates above.

## Launch conditions (all must hold before downloads are enabled)

1. HCG Store's server is deployed at `https://store.hakmicapitalgroup.com` and sign-in with its own **production**
   HCG Connect client (redirect `https://store.hakmicapitalgroup.com/auth/callback`) is verified with a real account
   (phases 1–2 of [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md)). The development client is refused in production.
2. HCG confirms central product IDs and the entitlement API (check, and grant/revoke for purchases).
   The Store is configured with `HCG_STORE_ENTITLEMENT_AUTHORITY=hcg-ecosystem`.
3. The acceptance list below passes against live HCG with real test accounts.
4. Private artifact storage is provisioned (`/data/artifacts` on the server's volume, with backups), and each file is
   either added to `server/data/artifacts.json` with its SHA-256 and `deliveryApproved: true`, or approved for public
   delivery in HCG Store through Ship to Store ([PUBLISHING.md](PUBLISHING.md)). Publishing being enabled does not
   satisfy this condition by itself: customer delivery is a separate switch.
5. The founder explicitly approves launch. Only then are `HCG_STORE_PROTECTED_DOWNLOADS=enabled` and
   `HCG_STORE_LAUNCH_APPROVED=founder-approved` set. The server refuses the first without the second.

## Acceptance list

`server/test/acceptance.test.ts` runs the real server code against a mock HCG Connect provider that
uses the live provider's protocol. `e2e/account.spec.ts` drives the same flows in Chromium.

1. Logged-out users cannot retrieve protected binaries directly.
2. Signed-in users without an entitlement cannot download paid products. Roles do not grant
   ownership, and buying one edition does not unlock another.
3. Authorised owners download the correct artifact; its bytes and SHA-256 match.
4. Failed payments, pending payments, visiting the return URL, forged return URLs, unsigned, wrongly
   signed, stale and under-priced events all grant nothing.
5. Duplicate payment events do not duplicate purchases. A second checkout for an owned product is
   refused.
6. Logout, idle expiry, central session end, an HCG outage, refund, administrator revocation and
   subscription cancel/expiry behave as documented above.
7. The library, product page, HCG Repo access endpoint and Sileo API report the same ownership.
8. No public URL bypasses the gate: the static site, path tricks, tampered or expired signed URLs,
   and the launch switch are all checked.

Results: [TEST-REPORT.md](TEST-REPORT.md).
