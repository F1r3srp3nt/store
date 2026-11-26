# HCG Mail for Windows 0.1.0-beta.1: free public testing release (approval package)

**Status:** prepared and rehearsed. **Not imported into production, not submitted, approved or published; no
testing period opened.** Production publishing and downloads stay off until you complete the founder operations below.

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

## 2. Access policy and governance

**Who can download**
- Any **signed-in HCG account**, during the free testing period.
- Signed-out visitors see the page and the "Temporarily free" badge, but cannot download.

**What is delivered**
- Only the four files of this release.
- Only after the release has been submitted, approved and, separately, published.
- Withdrawn or superseded releases are never delivered.

**Download mode:** `HCG_STORE_PROTECTED_DOWNLOADS=free-testing-only`.
- No licensed or paid file is delivered to anyone, owners included (and the Founder/Owner grant).
- Every other private release stays inaccessible.

**Testing period: 30 days from the moment of publication**
- It is prepared before publication (`starts: "publication", days: 30`) and starts at the exact publication time.
- A deployment delay therefore never shortens it.
- You can extend it (more days, or a later end) or end it at once (with a reason).
- After its end, free delivery stops by itself.
- Every change records who authorised it and who performed it, in an append-only log.

**No charge, ever**
- No offer, price, checkout, Stripe session, payment record or licence is created.
- When the period ends, the edition shows "Not for sale yet" and nothing is charged.
- The product's permanent pricing (`not-set`) is unchanged. Payments stay off.

**Three separate central permissions on `hcg.store`, each a distinct audited step in the browser**
- `store.publish` lets a person **submit** a draft for approval. It does not include approval or publication.
- `store.release.approve` lets a person **approve**, typing the version.
- `store.release.publish` lets a person **publish** an approved release, typing the version.

Holding these permissions:
- A desktop app can never approve or publish.
- Customers, purchases and owning a product grant none of these permissions.
- Uploading or importing files grants none of them.

**Founder-operated release exception (this release only)**
- Store's rule: whoever **created or submitted** a release may not approve or publish it.
- The CI build that produced the files is recorded as the creator but **is never counted as a second person**.
- So for you to submit, approve and publish this release yourself, the operator path records an explicit exception:
  - one account: yours, named by a verified sign-in reference, never an account ID in logs;
  - one release: this import's `rel-…`;
  - one exact file set: digest `7ee9f69885a75afcfd317295453f47c0c743b06d6ff4fdebaacc5a566c668067` over the four
    SHA-256 values and names;
  - a reason, and your written authorisation.
- The exception:
  - is shown on the review page as "not an independent review";
  - is written into the hash-chained audit and onto the approval and publication (`independentReview: false`);
  - stops applying if any file changes;
  - can be revoked;
  - is never a permission: you still need each of the three central grants.
- If you prefer a second person, give that person `store.release.approve` or `store.release.publish` and skip step 8.

## 3. Production steps (in order)

Steps marked **you** are founder operations. Steps marked **operator** are Actions runs of *Deploy Store server to
Fly.io*: the account is never printed, and payments stay `none` throughout.

1. **You: renew the Fly.io token.** Run the command below, then save the token as the repository secret
   `FLY_API_TOKEN`:
   ```bash
   fly tokens create deploy --app hcg-store --expiry 720h
   ```
   **Operator:** `mode=status` confirms that Fly.io accepts it.
2. **Operator: deploy main** (`mode=deploy`). This runs the tests, then a **migration dry run** on a copy of the live
   database on the Machine (no write; it stops if any row would be lost), then a **pre-deploy backup**, then the
   deployment and the smoke test.
   Then verify:
   - the live commit (`/hcg-build.json`);
   - health;
   - the six themes;
   - mobile navigation;
   - the catalogue;
   - Release Manager ("not enabled");
   - My Library.

   Nothing in this step enables publishing, downloads or payments.
3. **You, in HCG ERP (Owner):**
   - On `hcg.store`, create the feature `store.release.publish`. It is new; the other two exist.
   - Grant your account `store.publish`, `store.release.approve` and `store.release.publish`.
   - Grant nothing to customers or applications.
4. **Configuration**: a PR changing `fly.toml`, merged after your approval, then deployed:
   ```toml
   HCG_STORE_PROTECTED_DOWNLOADS = "free-testing-only"
   HCG_STORE_FREE_TESTING_APPROVED = "founder-approved"
   HCG_STORE_PUBLISHING = "enabled"
   HCG_STORE_PUBLISHER_CENTRAL_ID = "store.publish"
   HCG_STORE_RELEASE_APPROVER_CENTRAL_ID = "store.release.approve"
   HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID = "store.release.publish"
   # unchanged: HCG_STORE_PAYMENT_PROVIDER = "none"; HCG_STORE_PUBLISHING_CLIENT_IDS not set (no app uploads)
   ```
5. **You: sign in** to HCG Store once. **Operator:** `mode=evidence` shows that sign-in's 12-hex `session_ref`, with
   no account ID.
6. **Operator: import** with `mode=import-release`:
   ```json
   {"request":"hcg-mail-windows-0.1.0-beta.1.json","authorised_by":"<your words>","preserved_run":"45778776110"}
   ```
   - `preserved_run` uses the verified copy kept in this repository. Without it, the run downloads from HCG Mail's
     run, whose artifacts expire on 23 Feb 2027.
   - Every byte is verified again: size, SHA-256, `SHA256SUMS.txt` and each Release Passport (with SHA-512, commit and
     run).
   - Result: a **private draft**, `rel-…`.
7. **Operator: prepare the 30-day period** with `mode=free-window`:
   ```json
   {"command":"open","product":"hcg-mail","edition":"windows-desktop","release":"rel-…","starts":"publication","days":"30","authorised_by":"<your words>"}
   ```
8. **Operator: record the founder exception** with `mode=release-exception`:
   ```json
   {"command":"grant","release":"rel-…","session_ref":"<from step 5>","digest":"7ee9f69885a75afcfd317295453f47c0c743b06d6ff4fdebaacc5a566c668067","reason":"First Windows public prerelease of HCG Mail; founder-operated","authorised_by":"<your words>"}
   ```
9. **You, in the browser:** go to HCG Store → Release Manager → HCG Mail 0.1.0-beta.1, then:
   1. **Submit for approval**.
   2. **Approve**: eligibility `public`, *make current*, type `0.1.0-beta.1`.
   3. **Publish**: type `0.1.0-beta.1`.

   The 30-day period starts at that moment.
10. **Verify:**
    - as an ordinary account: download each file and compare its SHA-256;
    - signed out: refused;
    - Founder: only these four files;
    - payments: still disabled;
    - `/api/public/v1/release-resolution/hcg-mail` lists the four options as `free-testing`;
    - no other product changed.
11. **Catalogue:** `npm run releases:sync -- --production` generates the `releases.json` entry and `currentReleaseId`.
    A PR with them is merged, then deployed. The product page and the resolution then also work from the catalogue.

**Stopping it**
- **Free period:** `mode=free-window` with `{"command":"terminate","id":"fw-…","reason":"…","authorised_by":"…"}`. It
  takes effect on the next request.
- **Extending it:** `{"command":"extend","id":"fw-…","days":"45","authorised_by":"…"}`, or `"ends":"<ISO>"`.
- **Release:** in Release Manager, **Withdraw**. Delivery stops at once; files and history are kept.
- **Exception:** `mode=release-exception` with `{"command":"revoke","id":"rx-…","reason":"…","authorised_by":"…"}`.
- **Code:** roll back as in PRODUCTION-DEPLOY.md. The pre-deploy backup from step 2 is on the data volume
  (`/data/backups/hcg-store-predeploy-<time>-<commit>.sqlite`).

## 4. Rehearsal

The `release-import` workflow ran the real verified files through the Store code with the configuration in step 4
(latest: run `45778776110`, commit `32b5760`; earlier `45740215392`). It ran in TEST mode with TEST identities and never
touched production. Every check passed (`PASS` lines in the job log):

- **Import:** a private draft whose creator is recorded as `import:F1r3srp3nt/HCG-Mail#45686343504`, with nothing
  submitted. All four files were verified and unchanged; the SHA-256 values are the ones in section 1.
- **Testing period:** 30 days, prepared and waiting for publication.
- **Ordinary account:** could not submit and could not approve.
- **Submission:** the founder submitted (`store.publish`, browser).
- **Without an exception:** the submitter could not approve (`separation_of_duties`); the CI build is not a second
  person.
- **Founder-operated exception:** recorded for this release and these exact files (digest `7ee9f698…`).
- **Approval:** the founder approved (browser, typed version, `public`). Approved but not published, still nothing
  was delivered.
- **Publication:** an ordinary account could not publish. The founder published, with the separate permission.
- **Period started at publication:** it lasts exactly 30 days from the publication time.
- **Delivery:** free to any signed-in account, with 4 files, no offer and no checkout. The tester's four downloads
  matched the exact bytes.
- **Refusals:** signed out was refused, and termination stopped delivery at once.
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
