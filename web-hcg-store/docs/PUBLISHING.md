# Ship to Store: release publishing (HCG Executable Maker → HCG Store)

Status: **implemented and tested in TEST mode only.** Off by default (`HCG_STORE_PUBLISHING` unset). Nothing is
deployed; no central HCG policy, OAuth client or production security rule was changed. Enabling it needs the founder
decisions listed under *Launch prerequisites*.

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
- **May publish**: `authority.check(sub, HCG_STORE_PUBLISHER_CENTRAL_ID, <product id> | "*")`.
- **May approve**: `authority.check(sub, HCG_STORE_RELEASE_APPROVER_CENTRAL_ID, <product id> | "*")`.
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
   and notarisation result, Debian control fields) → **scoped upload URL** (HMAC, one file, one person, 15 min) →
   chunks with `Content-Range`, resumable at the last confirmed byte (`GET` the URL for the offset; expired URLs are
   renewed without losing bytes) → **complete**: the Store recomputes SHA-256, checks the format and archive safety,
   then moves the file to `releases/<product>/<release>/<sha-prefix>/<file>` (mode 0444). Rejected files are deleted
   from staging and recorded with the reasons.
4. **Draft review**: the review page (`/publishing/releases/<id>`) shows each file's kind, signature facts and install
   label, with **Download to review** for people HCG allows to publish or approve the product (short-lived grant,
   re-checked at use, audited as `approver-review`). Customers get 404, anonymous visitors 401. Uploading never makes
   a file public.
5. **Submit** locks the draft. **Approval is manual**: only in a browser session in HCG Store, by someone with the
   approver permission, typing the version; **public** additionally needs a different person than the creator and a
   catalogue product with a central ID. Desktop tokens cannot approve.
6. **Withdraw** (rollback): delivery stops on the next request, including links already issued; files and audit stay.

Supported files: Windows EXE/MSI/MSIX/ZIP, macOS app ZIP/DMG/PKG, iOS/iPadOS IPA (and jailbreak DEB), Linux
DEB/RPM/AppImage. Checks: allow-listed extension per platform; magic bytes (MZ/PE, OLE, UDIF `koly`, `xar!`, RPM lead,
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
`catalogue/products.json`. After public approval they are offered by the existing Sileo `authorize_download` (version
and architecture from the release), behind the same launch switch and entitlement check. **Not yet done (needs HCG Repo
changes, proposed here, not implemented there):** HCG Repo must list protected packages in `Packages` without hosting
the `.deb` (`docs/HCG-REPO.md`, remaining work 1), and its importer needs a source kind that pins a Store artifact by
SHA-256 (e.g. `kind = "hcg-store"`, `artifact`, `sha256`) so its review pipeline can record Store-held packages. No
payment or licence logic moves to HCG Repo.

## 6. Configuration

| Variable | Meaning |
|---|---|
| `HCG_STORE_PUBLISHING` | `enabled` / `disabled` (default) |
| `HCG_STORE_PUBLISHING_CLIENT_IDS` | Comma-separated HCG Connect client IDs allowed to call the publishing API |
| `HCG_STORE_PUBLISHER_CENTRAL_ID` | Central permission for publishing (must be issued by HCG) |
| `HCG_STORE_RELEASE_APPROVER_CENTRAL_ID` | Central permission for approval (must differ from the publisher one) |
| `HCG_STORE_UPLOAD_MAX_MB` (4096), `HCG_STORE_UPLOAD_CHUNK_MB` (8), `HCG_STORE_UPLOAD_URL_TTL_SECONDS` (900) | Limits |

No storage administrator key exists anywhere: files are written by the Store process into its private directory.

## 7. Launch prerequisites (founder decisions, not made)

0. **Decision D6** ([MAIN-SITE-INTEGRATION.md](MAIN-SITE-INTEGRATION.md)) keeps releases and files with HCG Store, with no
   central release-approval authority, so Ship to Store needs nothing from the main site for releases. D6 names the
   founder-reviewed `catalogue/releases.json` as the release record. **Open for the founder:** whether a release
   approved here must also be added to `catalogue/releases.json` (reviewed in git) before public delivery, or whether
   this approval (a different person, typed confirmation, audited) is that review. Until decided, keep publishing off.
1. HCG issues/confirms the central permission IDs for publishing and approval, and the entitlement API serves them
   (`hcg-ecosystem` authority). The deployed `/check` takes `feature_key: "download"` only, so the live authority
   cannot confirm these permissions and publishing fails closed (503); until then it can only run in TEST mode.
2. HCG Executable Maker's HCG Connect client is registered (its configuration still ships a placeholder) and added to
   `HCG_STORE_PUBLISHING_CLIENT_IDS`.
3. The Store is deployed with private storage and backups; the launch conditions in [ACCESS.md](ACCESS.md) still govern
   any download by customers.
4. Founder approval to set `HCG_STORE_PUBLISHING=enabled` in production.

## 8. Tests

- `server/test/publishing.test.ts` (12): kinds from content (Simulator refused declared and hidden, declaration
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
