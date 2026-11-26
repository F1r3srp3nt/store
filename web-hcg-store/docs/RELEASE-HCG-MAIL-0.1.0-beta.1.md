# HCG Mail for Windows 0.1.0-beta.1: free public testing release (approval package)

**Status:** prepared and rehearsed. **Not imported into production, not approved, not published, no window opened.**
Production publishing and downloads stay off until you approve this specific release.

## 1. The release

| | |
| --- | --- |
| Product / edition | `hcg-mail` (central `hcg.mail`) / `windows-desktop` |
| Version / build / channel | `0.1.0-beta.1` / `1` / `beta` (shown as **Public beta**) |
| Distribution | `free`, delivered only during a free testing window. No price or offer exists. Payments stay off |
| Source | `F1r3srp3nt/HCG-Mail` @ `8bb1a4f078326da6373962cb81a96f88675bc3f4`, GitHub Actions run `45686343504` |
| CI evidence | Windows regression tests 530 passed, 0 failed, 20 skipped (of 550); installer lifecycle and launch passed on GitHub-hosted Windows x64 (build 26100) and ARM64 (Windows 11 build 26200) |
| Code signing | **None.** No Authenticode signature on any installer or on HCGMail.exe |
| Import request | [`release-imports/hcg-mail-windows-0.1.0-beta.1.json`](../release-imports/hcg-mail-windows-0.1.0-beta.1.json) |

### Files (verified byte-for-byte; never rebuilt or altered)

The release-import workflow downloaded the run's artifacts. It checked each file's size and SHA-256 against
`store-release-draft.json` and `SHA256SUMS.txt`, and each file against its HCG Release Passport (schema at HCG Repo
`0c25d95`; size, SHA-256, SHA-512, source commit, run).

| File | Architecture | Type | Size (bytes) | SHA-256 | Min. Windows |
| --- | --- | --- | --- | --- | --- |
| `HCGMail-0.1.0-beta.1-win-x64-Setup.exe` | x64 | Installer (per-user) | 57,856,665 | `e87ed85fbb62974dfba0665a152936f26f2b90dcc804b7ae0eed0ff79da24466` | 10 (1607) |
| `HCGMail-0.1.0-beta.1-win-x64.zip` | x64 | Portable ZIP | 83,770,084 | `cf7a16732eb788e39cbfc1b7374f379391a132dfa2f69f408e858bdf2f5b7321` | 10 (1607) |
| `HCGMail-0.1.0-beta.1-win-arm64-Setup.exe` | ARM64 | Installer (per-user) | 54,671,358 | `ffb39988c3c5eea050134661a3c8d75274792fc6ea1180b2f59e6d1c0552c219` | 11 |
| `HCGMail-0.1.0-beta.1-win-arm64.zip` | ARM64 | Portable ZIP | 81,251,132 | `62e7cca424ea4a3ed3ccbfda5c8c90e1264447005798641bac6cc13f1e7bf06a` | 11 |

Passport validation levels for every file:
- **Static inspection:** passed.
- **Installation:** passed for the installers; not applicable to the ZIPs.
- **Application launch:** passed.
- **Runtime verification:** **partial**: Windows Credential Manager and TLS certificate validation passed;
  authenticated IMAP/SMTP was not exercised.

### Release notes (from the CI draft, unchanged)
- HCG Mail 0.1.0-beta.1 for Windows: public testing prerelease, free during testing (temporary; not a permanent free price).
- IMAP/SMTP email for your own mailbox. Passwords in Windows Credential Manager; TLS with certificate validation only.
- Installer (per-user, no administrator rights) or portable ZIP, for x64 and ARM64. Self-contained: no .NET installation needed.
- Not code-signed: Windows SmartScreen warns. Compare the SHA-256 checksum before running.
- Microsoft and Google sign-in are not set up in this build.

### Known limitations (shown with the release)
These come from HCG Mail's `docs/RELEASE_NOTES_0.1.0-beta.1.md` and the run's evidence:
- Not code-signed: SmartScreen warns. Run a file only if its SHA-256 matches.
- **Signing in to a mailbox, sending and receiving have not been tested on Windows yet.** The automated Windows checks
  covered installation, start-up, rendering, restart, Credential Manager and TLS validation.
- Verified on GitHub-hosted Windows runners only, not yet on testers' PCs.
- Microsoft and Google sign-in are not set up in this build.
- No automatic updates.
- English only.

### Product page
- **Badges and warnings:** official HCG Mail banner and icon; **Public beta**; **Free during testing** and **Temporarily free until \<date\>**
  (from the open window: "No payment details needed; nothing is charged when it ends"); a prominent **Not
  code-signed** warning with the `Get-FileHash` instruction.
- **Files:** Windows x64 and ARM64 installers and portable ZIPs, each with its real size (rounded and in exact bytes),
  SHA-256 and minimum Windows version.
- **Text:** release notes, known limitations, and system requirements (Windows 10 1607+ x64 or Windows 11 ARM64; no
  administrator rights or .NET; an IMAP/SMTP account).
- **Links:** **Report a bug or give feedback** (HCG Mail on GitHub Issues), plus the release notes link.
- **No validation claims:** features are labelled "tested against a real Dovecot/Postfix server; not yet on Windows".
  Nothing says authenticated email works on Windows.

Screenshots of the exact preview: artifact `publication-preview` of the release-import workflow run (section 4).

## 2. Access policy

- **Who:** any **signed-in HCG account**, while a free testing window is open. Signed-out visitors see the page and
  the "Temporarily free" badge, but download nothing.
- **What:** only the four files of this release, and only after a person has approved it and, separately,
  published it. Withdrawn or superseded releases are not delivered.
- **Mode:** `HCG_STORE_PROTECTED_DOWNLOADS=free-testing-only`. No licensed or paid file is delivered to anyone, also
  owners (including the Founder/Owner grant). Every other private release stays inaccessible.
- **Window controls**, each recorded with who authorised and who performed it:
  - **Open:** with a start and end (at most 366 days per window).
  - **Extend:** a later end.
  - **Terminate:** at once, with a reason; delivery stops on the next request.
  - **End:** after the end time, free delivery stops by itself.
- **No charge, ever:** no offer, price, checkout, Stripe session or payment record is created. When the window ends,
  the edition shows "Not for sale yet" and nothing is charged. The product's permanent pricing (`not-set`) is
  unchanged.
- **Separation of permissions** (central, on `hcg.store`):
  - `store.publish` lets a person submit drafts, for example from HCG Executable Maker; it is not used for this import.
  - `store.release.approve` approves, in a browser with the version typed.
  - `store.release.publish` publishes an approved release, in a browser with the version typed.

  Uploading or submitting never grants approval or publication. A desktop app can never approve or publish.
  Customers and purchases grant none of these.
- **Decision needed: one-person release.** This release's creator is the CI build (operator import), not a person.
  Your account can therefore approve and publish it alone; the Store still refuses approval by a release's creator.
  If you want a second human to review it, give `store.release.approve` or `store.release.publish` to someone else
  and let them do that step.

## 3. Production changes required (in order; nothing below has been done)

1. **Renew the Fly.io token** (blocks every production step):
   `fly tokens create deploy --app hcg-store --expiry 720h`, then save it as the GitHub secret `FLY_API_TOKEN`.
2. **Deploy main** (HCG Store v3 plus this release path, which is inert while publishing is off).
   Then verify: live commit, health, catalogue v2 pages, Release Manager answering "not enabled".
3. **HCG (ERP, Owner):**
   - create the feature `store.release.publish` on `hcg.store`; it is new;
   - give your account `store.release.approve` and `store.release.publish`;
   - also `store.publish` as you asked, which is not needed for this import.
4. **Configuration change**, applied as a PR after your approval, then deployed:

   ```toml
   HCG_STORE_PROTECTED_DOWNLOADS = "free-testing-only"
   HCG_STORE_FREE_TESTING_APPROVED = "founder-approved"
   HCG_STORE_PUBLISHING = "enabled"
   HCG_STORE_PUBLISHER_CENTRAL_ID = "store.publish"
   HCG_STORE_RELEASE_APPROVER_CENTRAL_ID = "store.release.approve"
   HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID = "store.release.publish"
   # unchanged: HCG_STORE_PAYMENT_PROVIDER = "none"; no Executable Maker client needed for this import
   ```
5. **Import:** Actions → *Deploy Store server to Fly.io*, `mode=import-release`, with these operator arguments:
   `{"request":"hcg-mail-windows-0.1.0-beta.1.json","authorised_by":"<your words>"}`.
   The run verifies the files again and imports them as a submitted private draft.
6. **You, in a browser:** HCG Store → Release Manager → HCG Mail 0.1.0-beta.1 → review page.
   - **Approve:** eligibility `public`, *make current*, type `0.1.0-beta.1`.
   - **Publish:** type `0.1.0-beta.1`.
7. **Open the window:** `mode=free-window`, with operator arguments
   `{"command":"open","product":"hcg-mail","edition":"windows-desktop","release":"<rel-… from step 5>","starts":"now","ends":"<end, e.g. 2027-01-31T23:59:59Z>","authorised_by":"<your words>"}`.
8. **Catalogue:** run `npm run releases:sync -- --production` and open a PR with the generated `releases.json` entry
   and `currentReleaseId`. That PR also confirms the Windows platform (x64, ARM64, minimum versions). Merge it, then
   deploy, so the release panel appears on the product page.
9. **Verify:**
   - as an ordinary account: download each file and compare its SHA-256;
   - signed out: refused;
   - Founder: only these files;
   - payments: still disabled.

**Stopping it:**
- **Free period:** `mode=free-window` `{"command":"terminate","id":"fw-…","reason":"…","authorised_by":"…"}`. This
  takes effect on the next request.
- **Release:** in Release Manager, **Withdraw**. Delivery stops at once; files and history are kept.
- **Code:** rollback as in PRODUCTION-DEPLOY.md.

## 4. Rehearsal

The `release-import` workflow ran the real verified files through the Store code with the configuration in step 4
(run `45740215392`, commit `e0de2cd`). It ran in TEST mode with TEST identities and never touched production. Every
check passed (`PASS` lines in the job log):

- **Import:** a submitted private draft whose creator is `import:F1r3srp3nt/HCG-Mail#45686343504`. All four files
  verified and unchanged; the SHA-256 values are the ones in section 1.
- **Before approval:** nothing was delivered to the tester.
- **Approval:** an ordinary account could not approve. The founder then approved (browser, typed version, `public`).
- **Before publication:** approved but not yet published, so still nothing was delivered.
- **Publication:** an ordinary account could not publish. The founder then published, with the separate permission.
- **No window:** once published, the edition was neither free nor for sale.
- **Window open:** the edition was free to any signed-in account, with 4 files, no offer and no checkout. The tester's
  four downloads matched the exact bytes.
- **Refusals:** a signed-out request was refused, and termination stopped delivery at once.
- **No commerce:** no purchase, payment or licence record was created.
- **Catalogue:** the entry was generated (`hcg-mail: current release none → rel-… (approver's choice)`) and validates.

### Publication preview: the generated `catalogue/releases.json` entry

The production release ID, approval time and audit hash are assigned at import and approval. Everything else is
exactly what `npm run releases:sync` writes:

```json
{
  "id": "rel-<assigned at import>",
  "productId": "hcg-mail",
  "version": "0.1.0-beta.1",
  "build": "1",
  "channel": "beta",
  "status": "approved",
  "releaseDate": "<approval date>",
  "releaseNotes": ["… the five release notes in section 1 …"],
  "knownLimitations": ["… the six limitations in section 1 …"],
  "artifacts": [
    { "fileName": "HCGMail-0.1.0-beta.1-win-arm64-Setup.exe", "platform": "windows", "architectures": ["arm64"], "format": "exe", "sizeBytes": 54671358, "sha256": "ffb39988c3c5eea050134661a3c8d75274792fc6ea1180b2f59e6d1c0552c219", "minimumOs": "Windows 11", "signing": { "status": "unsigned" } },
    { "fileName": "HCGMail-0.1.0-beta.1-win-arm64.zip", "platform": "windows", "architectures": ["arm64"], "format": "zip", "sizeBytes": 81251132, "sha256": "62e7cca424ea4a3ed3ccbfda5c8c90e1264447005798641bac6cc13f1e7bf06a", "minimumOs": "Windows 11", "signing": { "status": "unsigned" } },
    { "fileName": "HCGMail-0.1.0-beta.1-win-x64-Setup.exe", "platform": "windows", "architectures": ["x64"], "format": "exe", "sizeBytes": 57856665, "sha256": "e87ed85fbb62974dfba0665a152936f26f2b90dcc804b7ae0eed0ff79da24466", "minimumOs": "Windows 10 1607", "signing": { "status": "unsigned" } },
    { "fileName": "HCGMail-0.1.0-beta.1-win-x64.zip", "platform": "windows", "architectures": ["x64"], "format": "zip", "sizeBytes": 83770084, "sha256": "cf7a16732eb788e39cbfc1b7374f379391a132dfa2f69f408e858bdf2f5b7321", "minimumOs": "Windows 10 1607", "signing": { "status": "unsigned" } }
  ],
  "source": { "kind": "hcg-store-approval" }
}
```

Every artifact also carries `editionId: "windows-desktop"` and `sourceCommit: 8bb1a4f…`. It also records
`buildProvider: github-actions` and the toolchain: .NET SDK 10.0.404, runtime 10.0.15, HCG Executable Maker engine
`595e989a47c9`, and Inno Setup 6.7.1. No download URL appears anywhere in the public catalogue.

### Artifact `publication-preview`

The artifact holds the full entry, the rehearsal log, and screenshots of:
- the product page, signed out and as a tester at 1440 and 390px;
- Release Manager;
- the review page.
