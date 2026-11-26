# Ship to Store: release publishing (HCG Executable Maker → HCG Store)

Status (16 Nov 2026): **merged on `main`; tested in TEST mode only; not deployed.** Off by default
(`HCG_STORE_PUBLISHING=disabled` in `fly.toml`). The release-review question is decided: the manual approval in HCG
Store is the review (§3a). Production activation is phase 3 in [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md), after
sign-in (phase 2), and separate from customer payments and downloads. No central HCG policy, OAuth client or production
security rule was changed.

## 1. Compatibility and security report (inspection of the existing Store)

| Area | What already existed | Verdict |
|---|---|---|
| Identity | HCG Connect relying party (PKCE, ES256 JWKS, issuer/audience/`client_id` checks), opaque `__Host-` session, no user table, no roles | Reused. Desktop clients authenticate with their own HCG Connect access token (allow-listed `client_id`), never the Store's session. |
| Ownership | Entitlement authority (`hcg-ecosystem` read-only API, or the TEST ledger); roles never grant anything | Reused, and also used for **publishing permissions** (central permission IDs), so the Store has no permission table of its own. |
| Products / releases | Public catalogue (`catalogue/*.json`), founder-reviewed in git; **no releases** yet; `currentReleaseId` explicit | Kept as the public source. Ship to Store keeps drafts in the Store database; a public release needs a catalogue product with a confirmed central ID. |
| Binary storage | Private directory (`HCG_STORE_ARTIFACT_STORAGE_DIR`) outside the static root; `server/data/artifacts.json` maps files (empty); path traversal refused | Reused for uploads (content-addressed, read-only files). |
| Upload | **None** (files were placed by hand) | **Added**: scoped, resumable uploads with server-side hashing and validation. |
| Download | `GET /api/v1/downloads/:id` (session → launch switch → entitlement → delivery approval → approved release), Sileo 120 s signed URLs re-checked at use | Reused: approved public Ship to Store files flow into these paths. Added short-lived download grants for publishers/testers. |
| Audit | Payment events table | **Added** append-only, hash-chained publishing audit (DB triggers forbid update/delete). |
| HCG Repo | Public GitHub Pages APT repo; validator refuses paid/login packages; Store serves Sileo's payment API | Reused; `.deb` files for HCG Repo are held by the Store and delivered through the existing Sileo path once approved. |

Could compiled binaries be uploaded, stored and downloaded securely before this change? **Stored and downloaded: yes**
(private storage + gated delivery, already tested). **Uploaded: no** — there was no upload path. That is what this
change adds; nothing that worked was replaced.

## 2. Authority (no second identity or permission system)

- **Who**: HCG Connect. Bearer tokens must be issued to a client in `HCG_STORE_PUBLISHING_CLIENT_IDS`
  (HCG Executable Maker's own client); signature, issuer and subject are verified against HCG Connect's JWKS.
  In production that is HCG Executable Maker's production client `fb9b6edf-2bfc-4b5e-a354-dbb1af697029` (issued by HCG,
  `configured_untested`). The server refuses the Store's own sign-in client and, in production, development clients.
- **May publish / may approve**: HCG's personal grants `store.publish` and `store.release.approve` on HCG Store's own
  central product `hcg.store` (main-site contract v2, 17 Nov 2026), whatever product is being published. Checked on
  every action with the caller's own HCG token: `POST /check {org_id, product_id: "hcg.store", feature_key}` for each
  organisation from `/me`. Granted only on `allowed: true` echoing that organisation, product and feature; anything
  else is "not permitted" (or 503 when HCG cannot answer). Never inferred from owning a product, a Maker licence,
  organisation membership, an HCG role, a Store profile, or anything the client sends. Draft products and products
  HCG has not registered can never be approved for public delivery.
- **Central state (17 Nov 2026):** both features exist on `hcg.store`, locked to personal grants (membership, licences
  and purchases never suffice), assigned and revoked only by the Owner in ERP with `feature.grant` / `feature.revoke`
  audit entries. Both are **disabled/planned and granted to nobody**, so `/check` refuses everyone and publishing stays
  off in production. Store keeps its own different-person rule for public approval on top of the central grant.
- **May download a public paid/subscription/entitlement release**: the product's central entitlement, exactly as
  before. Free public releases: any signed-in HCG account. Internal testing: a central entitlement for the product.
  Private: publishers only. HCG roles are never read.

## 3. Workflow

1. Maker (signed in with HCG Connect) lists products the person may publish, or creates a **draft product** (Store-only;
   private/internal releases only until HCG adds it to the catalogue with a central ID).
2. **Private draft release**: product, edition, SemVer version, build number (unique per product/edition — releases are
   immutable; also for products without editions), channel, notes, compatibility, distribution (free/paid/subscription/
   entitlement — prices stay with HCG's offers), requested eligibility (private/internal-testing/public), destinations
   (HCG Store, HCG Repo). **Idempotent:** the same person asking again for the same version and build with the same
   details gets the existing draft back (`200`, `reused: true`); different details → `409 draft_exists` naming the draft;
   a submitted/approved/withdrawn release → `409 version_exists`.
3. **Each file**: declared (name, platform, format, size, SHA-256, architectures, minimum OS, the uploader's signature
   and notarisation result, Debian control fields, and **build provenance**: source commit, build provider — `local`,
   `github-actions` or `hcg-server-build-host` — toolchain and the uploader's own validation report; optionally the
   file it `replaces`) → **scoped upload URL** (HMAC, one file, one person, 15 min) →
   chunks with `Content-Range`, resumable at the last confirmed byte (`GET` the URL for the offset; expired URLs are
   renewed without losing bytes) → **complete**: the Store recomputes SHA-256, checks the format and archive safety,
   then moves the file to `releases/<product>/<release>/<sha-prefix>/<file>` (mode 0444). Rejected files are deleted
   from staging and recorded with the reasons.
4. **Draft review**: the review page (`/publishing/releases/<id>`) shows each file's kind, signature facts and install
   label, with **Download to review** for people HCG allows to publish or approve the product (short-lived grant,
   re-checked at use, audited as `approver-review`). Customers get 404, anonymous visitors 401. Uploading never makes
   a file public.
5. **Submit** needs release notes and, on every verified file, the source commit, build provider and toolchain
   (`409 provenance_required` names the files; drafts without them still work, so older Maker versions can upload). The
   source repository is never asked for: a private repository stays private. **Approval is manual**: only in a browser
   session in HCG Store, by someone with the approver permission, typing the version; **public** additionally needs a
   person other than the creator and the submitter (or a founder-operated exception for that exact release; see
   STORE-OWNER.md) and a catalogue product with a central ID. Desktop tokens cannot approve.
6. **Publish** (public releases only) is a separate, explicit step after approval, on the review page or the Release
   Manager: browser session, publication permission (`store.release.publish`), a person other than the creator and the
   submitter (or the same founder-operated exception), typed version. The publisher may
   choose to **supersede** the edition's currently published releases. Nothing is published automatically, and nothing
   is delivered to customers, listed for HCG Repo/Sileo or exported to the catalogue before publication. Internal-testing
   releases are delivered to testers once approved.
7. **Changing files invalidates approval.** Adding, replacing or removing a file of a submitted or approved (not yet
   published) release takes it back to draft, clears the approval and records `release.approval-invalidated`; it must be
   submitted and approved again. Published, superseded and withdrawn releases accept no file changes; verified files
   themselves are immutable (database triggers) and a replaced file is kept, outside the release.
8. **Withdraw** (rollback): delivery stops on the next request, including links already issued; files and audit stay.

### 3b. Release Manager

Stages (`stage` on every release, derived, never stored): draft → validation pending (an upload in progress) →
validation failed (only rejected files) / artifacts uploaded → awaiting approval → approved → **published** →
superseded; withdrawn from any stage. `/release-manager` (signed in) lists every release of every product the account
may publish or approve (`GET /api/v1/publishing/manager`), grouped by product as a version history, and offers:
- **Review, approve or publish**: the review page; approval and publication are never done from the list.
- **Verify checksums** (`POST …/releases/:id/verify-checksums`): re-hashes the stored files against their recorded
  SHA-256 (audited); a mismatch answers `409` with the files named.
- **Compare** (`GET /api/v1/publishing/compare?from=&to=`): changed fields, release notes added/removed, and files
  added, removed, changed (size and SHA-256, provenance) or identical, matched by platform, format and architectures.

Superseded releases stay in the history and the catalogue, but are no longer delivered (`410 superseded`).

### 3a. Release review and catalogue records

The manual approval in HCG Store **is** the release review. There is no second, independent review in git:
- it needs `store.release.approve` for the product, a browser session, the typed version, and for `public` a person
  other than the creator and the submitter (`separation_of_duties`; a CI build is never counted as a person) and a
  product with a central ID;
- each step is in the append-only, hash-chained publishing audit (database triggers forbid update and delete).

Delivery follows **publication** (the explicit step after approval): published public files are served through the
gated download paths, and a withdrawal stops them, with or without a catalogue change. Only published releases (also
those later superseded or withdrawn) are exported to the catalogue.

`catalogue/releases.json` is still needed for the public storefront's release pages (version, notes, files and
checksums, never a URL). It is **generated** from the approval records:
- `node server-dist/release-records.mjs` (on the server) prints the public approvals and whether the audit chain
  verifies. `npm run releases:sync -- --production` reads them through `fly ssh console`, refuses a broken audit chain,
  and rewrites only the generated entries (`source.kind: "hcg-store-approval"`, each with the approval's audit hash).
  Hand-written entries are kept. `--check` only reports whether the catalogue is behind.
- Releases of the same product and version (several editions or builds) become one catalogue release.
- `currentReleaseId` changes only when the person publishing chose **make current** (at publication, or at approval
  when publication did not say; recorded in the audit),
  never because a version is newer, and is cleared when that release is withdrawn.
- Signing facts are labelled as reported by the uploading tool, not verified by the Store.
- Committing the regenerated files publishes what was already approved; the commit is not a review.

**Eligible approvers.** Public approval needs two different HCG accounts: a publisher (`store.publish`) and an approver
(`store.release.approve`) for the product. HCG Store cannot list who holds a central permission. Since HCG has not
created either feature, **no eligible approver exists today**, so no release can be approved for public delivery in
production. The founder must have HCG grant `store.release.approve` to at least one person other than the publisher.

Supported files: Windows EXE/MSI/MSIX/ZIP, macOS app ZIP/DMG/PKG, iOS/iPadOS IPA (and jailbreak DEB), Linux
DEB/RPM/AppImage, Android APK and App Bundle (AAB). An **APK** must contain `AndroidManifest.xml` and `classes.dex`; its
signature structure (v1 `META-INF/*.RSA|DSA|EC` or the v2+ APK Signing Block) is reported as present, never verified;
an unsigned APK blocks public approval. An **App Bundle** must contain `base/manifest/AndroidManifest.xml`; it is for
authorised distribution (such as Google Play) only: publishers and approvers can download it to review, customers never
(`403 staff_only`), and it is left out of Sileo, HCG Repo listings and the catalogue export. IPAs are likewise never
assumed to install directly: their label follows the provisioning profile. Checks: allow-listed extension per platform; magic bytes (MZ/PE, OLE, UDIF `koly`, `xar!`, RPM lead,
ELF+AppImage type 2, ar+`debian-binary`); ZIP/IPA/MSIX entries (absolute paths, `..`, backslashes, drive letters,
control characters, symlinks, encryption, expansion ratio, total size); IPA must contain `Payload/<app>.app/Info.plist`
only (plus Apple's Symbols/SwiftSupport); MSIX needs `AppxManifest.xml`; macOS ZIP needs a top-level `.app` with
`Contents/Info.plist`; DEB control fields (gzip control archives) must match the declaration and, for HCG Repo, the
catalogue's package mapping. **Signatures**: the Store reports only whether a signature structure is present; the
uploader's verification result is stored as *reported*, never as Store-verified.

**Kinds and install labels** (`artifact-validation.ts`: `inspectContent`, `installReadiness`). The Store decides each
file's kind from its content: installer (EXE/MSI/MSIX/DMG/PKG/RPM, Linux DEB), portable app (ZIP, AppImage), iOS device
build (IPA), iOS Simulator build (an IPA whose Info.plist names the Simulator platform — **refused**: it cannot be
installed on an iPhone or iPad; a declaration of `simulator-build` is refused before upload), jailbreak package (DEB with
an `iphoneos-*` architecture; declaring it for Linux, or a non-iOS architecture for iOS, is refused). The uploader may
declare a `kind`; a contradiction is refused. For IPAs the Store reads `embedded.mobileprovision` (development, ad hoc,
in-house, App Store, none; the CMS signature is not verified by the Store). The label is never "installable" for an
unsigned, Simulator-only or jailbreak-only file. **Public approval is refused** while a release contains an unsigned
iOS device build or one signed without a profile.

## 4. API

See the header of `server/src/publishing.ts`. Review page: `GET /publishing/releases/<id>` (signed-in publisher or
approver). All responses are `private, no-store`.

## 5. HCG Repo destination

Releases with destination `hcg-repo` accept `.deb` files whose package ID maps to the release's product and edition in
`catalogue/products.json`. The Debian version must be the release version or `<version>-<revision>` (otherwise Sileo's
`authorize_download` could never match it). After public approval they are offered by the Sileo provider
(`authorize_download`), behind the launch switch and the entitlement check. HCG Repo never holds the `.deb`.

The Store-held package contract with HCG Repo (HCG Repo `docs/STORE_RELEASES.md`):
- HCG Repo pins each Store-held package by the Store artifact's SHA-256 (`import-store-release`), lists it as
  `cydia::commercial` with a `Filename` it never serves, and points `payment_endpoint` at
  `https://store.hakmicapitalgroup.com/repo-api/v1/sileo/` (https only; Sileo refuses http).
- `GET /api/v1/repo/releases?destination=hcg-repo` (signed in, or a publishing client token): releases approved for
  public delivery and those withdrawn after it, with each verified `.deb`'s id, SHA-256, size, architectures and
  control fields. Metadata only. Shown per product to people HCG lets publish or approve that product (HCG has no
  separate HCG Repo maintainer permission). HCG Repo uses it to see approvals and withdrawals.
- A release approved as **public and free** is available to every signed-in HCG account (HCG Repo's `connect` level):
  access state `free`, not ownership. Paid releases still need the edition entitlement.
- Companion changes for HCG Repo, not made by HCG Store: its staging harness grants the old permission names and ships
  the same `.deb` under a bumped release version (now refused by design), and expects an entitlement revocation to block
  a free package (it no longer applies; withdrawal and sign-out do). Its page script should show the new `free` state.

## 6. Configuration

| Variable | Meaning |
|---|---|
| `HCG_STORE_PUBLISHING` | `disabled` (default) · `submissions`: private drafts, uploads, Release Passports, submission, review and approval; **public publication and delivery stay off** · `enabled`: also the explicit public publication of an approved release (§6a) |
| `HCG_STORE_PUBLISHING_CLIENT_IDS` | Optional. Comma-separated HCG Connect client IDs allowed to call the publishing API. Production: `fb9b6edf-2bfc-4b5e-a354-dbb1af697029` (Executable Maker). Must be issued UUIDs; never the Store's own client or, in production, a development client. Without it, releases arrive only through the operator import |
| `HCG_STORE_PUBLISHER_CENTRAL_ID` | Central feature checked per product for publishing: `store.publish` |
| `HCG_STORE_RELEASE_APPROVER_CENTRAL_ID` | Central feature checked per product for approval: `store.release.approve` |
| `HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID` | Central feature checked for publication of an approved release: `store.release.publish`. The three IDs must all differ. Required with `enabled`; not needed with `submissions` (nothing can be published then) |
| `HCG_STORE_PROTECTED_DOWNLOADS` | `disabled` (default) · `free-testing-only`: only files of releases published as public and free, during an open free testing window (needs `HCG_STORE_FREE_TESTING_APPROVED=founder-approved` in production) · `enabled`: also licensed and paid downloads (needs `HCG_STORE_LAUNCH_APPROVED=founder-approved`) |
| `HCG_STORE_ARTIFACT_STORAGE_DIR` | Private directory on the data volume (`/data/artifacts`), outside the static root |
| `HCG_STORE_UPLOAD_MAX_MB` (4096), `HCG_STORE_UPLOAD_CHUNK_MB` (8), `HCG_STORE_UPLOAD_URL_TTL_SECONDS` (900) | Limits |
| `HCG_STORE_STORAGE_QUOTA_MB` | Optional. Total size of release files the Store keeps (staging included); a declaration that would exceed it is refused with `quota_exceeded`. Unset: no quota |

No storage administrator key exists anywhere: files are written by the Store process into its private directory.

### 6a. Private submissions without public publication, and diagnostics

Ship to Store is first an artifact submission feature: a person builds an application in HCG Executable Maker, uploads
it, and it waits privately for review. `HCG_STORE_PUBLISHING=submissions` allows exactly that and nothing public:

| Stage | `disabled` | `submissions` | `enabled` |
|---|---|---|---|
| Product list, private draft, resumable upload, server SHA-256, Release Passport, submit for review | off | **on** | on |
| Release Manager, review, manual approval (browser) | off | **on** | on |
| Public publication of an approved release (browser, separate permission) | off | **off** (`409 publication_disabled`) | on |
| Delivery to anyone but the people who submit and review (downloads, internal-testing downloads, Sileo, release resolution, HCG Repo indexing; HCG Repo still sees withdrawals) | off | **off** (`403 publication_disabled`) | per launch switches |

`GET /api/v1/publishing/status` answers in every mode, without sign-in, so an app can say precisely what is off and why:
API version and `minimumClientApiVersion`, the mode, whether HCG Connect is configured, the permission IDs, and each
stage with `available`, `where` (app or browser) and the reason when it is off. With a bearer token it also reports,
separately: whether the token is valid, expired or unverifiable; the HCG Connect client it was issued to and whether
that client is registered for publishing (and why not: another app's client, or the Store's own web sign-in); each of
HCG's permissions (`granted`, `not-granted`, `unavailable`, `not-configured`, `switched-off`); and how many products the
account may submit. The token is never echoed. HCG Executable Maker's Ship to Store diagnostics read this endpoint.

**Proposal for founder review (not applied):** after phases 2–3 of PRODUCTION-DEPLOY.md pass, production can move to
`HCG_STORE_PUBLISHING = "submissions"` (with the client and the publisher and approver permission IDs uncommented in
`fly.toml`) so Executable Maker can upload private drafts while public publication stays off. `fly.toml` still says
`disabled`; nothing was deployed.

## 7. Production prerequisites (phase 3 in PRODUCTION-DEPLOY.md)

| # | Prerequisite | Status |
|---|---|---|
| 1 | Release review decided | **Done**: Store approval is the review; the catalogue is generated (§3a) |
| 2 | HCG Store server deployed with HTTPS, persistent private storage and backups | **Prepared, not deployed** (phases 0–1) |
| 3 | HCG Store sign-in verified in production with its own production client | **Not done**: client not issued (phase 2) |
| 4 | Executable Maker's client issued | **Done by HCG** (`fb9b6edf-…`, `configured_untested`); configured in `fly.toml`, commented until phase 3 |
| 5 | HCG creates `store.publish` and `store.release.approve` as per-product features with per-person grants (membership alone must not pass) | **Not done** (main-site plan steps 3–4, awaiting founder approval) |
| 6 | Two different people hold the permissions (publisher, approver) | **Not done**: no eligible approver exists |
| 7 | Publishing checks pass in production (PRODUCTION-DEPLOY.md, phase 3) | **Not run** |
| 8 | Founder approval to set `HCG_STORE_PUBLISHING=submissions` (private uploads and review only, §6a) | **Not given** |
| 9 | Founder approval to set `HCG_STORE_PUBLISHING=enabled` (public publication) | **Not given** |

Customer delivery of approved files stays behind the separate launch conditions in [ACCESS.md](ACCESS.md).

## 8. Tests

- `server/test/publishing.test.ts` (15). New on 16 Nov: permissions per product (a grant for one product, ownership, a
  role or the publisher feature never permits another product or approval); the Debian version rule, free public
  releases for any signed-in account, the HCG Repo listing and withdrawal; catalogue generation from approvals
  (explicit current release, withdrawal, refusal on a broken audit chain). Earlier (12): kinds from content (Simulator refused declared and hidden, declaration
  contradictions, unsigned / no profile / development / ad hoc / in-house / App Store IPAs, jailbreak vs Linux DEB),
  labels on the review page, public approval refused for an unsigned device build; approver draft review download with
  identical bytes, customers refused, nothing public, unauthorised file additions and forged upload URLs refused;
  idempotent draft creation and one release per version/build without editions; client allow-list, forged tokens, roles ≠ permissions; private draft, chunked
  upload, SHA-256, immutable storage; hash mismatch, wrong format, unsafe archive paths, refused names/types, recovery;
  resume after a broken chunk and an expired URL; manual approval rules (desktop refused, self-approval refused, CSRF,
  typed confirmation), review page metadata, entitlement-gated delivery, revocation and expired links; withdraw/rollback;
  DB-level immutability and append-only audit; draft products stay private; HCG Repo `.deb` mapping and Sileo metadata.
- End to end with HCG Executable Maker (its real sign-in code, CLI, upload and verification, and a real build shipped
  from the app's New Build result): `tools/ci/ship-to-store-e2e.sh` in the Maker repository (26 checks) against
  `server/test/ship-e2e-server.ts` (TEST only; its `/review` control signs a person in through the browser flow and
  presses *Download to review*).

## HCG Store Manager (administration client)

HCG Store Manager (native macOS) uses this same publishing API. There is no second upload path or database.

- **`GET /api/v1/publishing/capabilities`** returns the API version, upload limits, formats, build providers, storage
  use and quota. Only people HCG lets submit, approve or publish can call it.
- **Uploads** use the same declared, scoped, short-lived, resumable chunk uploads. HCG Store hashes and validates every
  complete file itself, and refuses the same bytes twice in one release.
- **Manual uploads** declare `buildProvider: "manual-upload"` and claim no source commit or toolchain; a declaration
  that claims either is refused. They can be submitted, and the review page shows them as "Manual upload: no build
  evidence".
- **`POST /api/v1/publishing/artifacts/:id/passport`** attaches an HCG Release Passport v1 to a verified file of a
  **draft**. It is accepted only when the passport's name, size, SHA-256 and SHA-512 match the stored bytes; otherwise
  the answer is `passport_mismatch`. The passport is shown as evidence next to the declared provenance and never
  rewrites it.
- **Approval and publication** stay browser-only, on the review page; the app opens that page.
- **Tokens:** HCG Store accepts the app's tokens only after HCG issues it a client ID and that ID is added to
  `HCG_STORE_PUBLISHING_CLIENT_IDS`.
