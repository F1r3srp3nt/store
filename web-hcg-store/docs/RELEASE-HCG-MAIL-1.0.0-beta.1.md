# HCG Mail 1.0.0 | Public Beta 1: first public release (Windows x64)

**Decision (founder, 27 Nov 2026):**
- Publish HCG Mail as a **free public beta**: 0 NOK, no checkout, no card, no subscription, no expiry.
- Downloads need **no HCG account**, for HCG Mail only.
- **Windows x64 now.** Both macOS files are **held** until a correctly signed build is attached to GitHub (see
  section 3).

## 1. Verified artifacts

Source: the GitHub releases the HCG Mail team created by hand on `F1r3srp3nt/HCG-Mail`. Both tags point to commit
`90726ae21d42f25cdc5ca81d97ab334d5dd5dfce`.

The evidence comes from HCG Store's read-only workflow
[`hcg-mail-release-evidence.yml`](../../.github/workflows/hcg-mail-release-evidence.yml), runs `45940033340` and
`45940124443`:
- an Ubuntu runner downloaded the assets;
- a Windows Server 2025 runner checked the Windows file;
- an Apple Silicon macOS 15 runner checked the macOS files.

Nothing was rebuilt, repackaged or modified.

| | Windows | macOS installer | macOS application |
|---|---|---|---|
| File (exact name on GitHub) | `HCGMail.exe` | `HCG.Mail-1.0.0-osx-arm64.pkg` | `HCG.Mail.app.zip` |
| GitHub release | `v1.0.0.0-beta.1-windows-x64` (prerelease) | `v1.0.0-beta.1-macos-arm64` (prerelease) | same |
| Size | 119,023,581 bytes | 52,517,680 bytes | 52,516,873 bytes |
| SHA-256 | `0424c7c6a264b66da841e320b2661fdcf9b2d8bf0bf17e3ab1ec92af32202fdf` | `84dc5b50f6ac59bc7f6e4b62f1c626ce548b0a7f4171a433f4c499a67013cc00` | `72029dbd965e4d9cda1f429b55552810eb15a71fc1b0e34cfc42d4fd79610a91` |
| Equals GitHub's asset digest | yes | yes | yes |
| Format | PE32+ GUI executable, single-file .NET 10 app (Avalonia) | xar flat installer package (component pkg, installs to `/Applications`) | ZIP (stored) of `HCG Mail.app` |
| Embedded version | ProductVersion `1.0.0`, FileVersion `1.0.0.0`, company Hakmi Capital Group | pkg `1.0.0`; app `CFBundleShortVersionString 1.0.0`, build `1.0.0` | app `1.0.0`, build `1.0.0`, `com.hakmicapitalgroup.hcgmail` |
| OS / architecture | Windows, x64 | macOS 11+, arm64 only (`hostArchitectures="arm64"`) | macOS 11+ (Info.plist; binary built for 12.0), arm64 only |
| Signing | **None** (Authenticode: NotSigned) | **None** (`pkgutil`: no signature; Gatekeeper: rejected) | **Broken ad-hoc** (`codesign --verify`: "code has no resources but signature indicates they must be present"; no Team ID; Gatekeeper: rejected) |
| Notarization | n/a | **No** (no ticket) | **No** (no ticket) |
| Start-up check | Started; window "HCG Mail" up after 20 s | (same app as the ZIP: identical main executable `9ab04689…`) | Started; running after 20 s (quarantine removed) |
| Build provenance | **None**: built by hand, no CI run, no Release Passport | None | None |

**Version.**
- The binaries report **1.0.0**.
- The Store lists the release as **1.0.0-beta.1** ("HCG Mail 1.0.0 | Public Beta 1"), as the founder named it. The
  release record carries a note saying so.
- The build field is the Windows file version, `1.0.0.0`.

**Same app in both macOS formats.** The PKG and the ZIP contain the same `HCG Mail.app`, with a byte-identical main
executable. They are two distribution formats of one release, not two versions.

## 2. What is published now

| Product / edition | `hcg-mail` (existing product, central `hcg.mail`) / `windows-desktop` |
|---|---|
| Release | `1.0.0-beta.1`, build `1.0.0.0`, channel `beta` (shown as **Public Beta**), distribution `free` |
| File | `HCGMail.exe`, Windows x64, kind *portable app* (declared; an `.exe` header cannot show it) |
| Price | Free: the edition's `pricingModel` is `free` (permanent; no window, no expiry). No offer, checkout or payment record exists |
| Access | No HCG account needed (`HCG_STORE_ANONYMOUS_FREE_PRODUCTS=hcg-mail`) |
| Import request | [`release-imports/hcg-mail-windows-1.0.0-beta.1.json`](../release-imports/hcg-mail-windows-1.0.0-beta.1.json) (`source.kind: github-release`) |

The product page lists these known limitations next to the download:
- the file is not code-signed;
- there is no build provenance;
- the binary's version number reads 1.0.0;
- start-up was verified on a CI runner only, and mailbox use was not tested by the Store;
- there is no Microsoft OAuth sign-in;
- there is no ARM64 build and no automatic updates.

## 3. macOS: what is needed before it is published

The application in the ZIP fails Apple's own signature check. Downloaded through a browser, macOS will most likely
refuse it as "damaged", and Open Anyway does not help with that. The PKG is unsigned.

**What to attach.** Attach a new build to the GitHub release (new names or new tags are fine). At minimum, a **valid
ad-hoc signature**:

```bash
codesign --force --deep --sign - "HCG Mail.app"
```

Ideally a **Developer ID** signature with **notarization** and a stapled ticket. Then:
- package the ZIP with `ditto -c -k --keepParent`;
- build the PKG from the signed app.

**What happens next.**
- HCG Store verifies the new files the same way, with the same workflow, and imports them as one macOS release.
- The release has two files, PKG and ZIP, in a new `macos-desktop` edition.

## 4. Configuration (fly.toml) and its effect

| Setting | Value | Effect |
|---|---|---|
| `HCG_STORE_PUBLISHING` | `uploads` → `enabled` | Approval and publication are possible, each still with its own central permission and a person in the browser |
| `HCG_STORE_PUBLICATION_PRODUCTS` | `hcg-mail` (new) | Only HCG Mail can be approved, published, re-enabled or restored, and delivered. Every other product stays uploads-only, even for people holding the permissions |
| `HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID` | `store.release.publish` | The central permission for publication. The feature must exist on `hcg.store` in HCG ERP and be granted |
| `HCG_STORE_PROTECTED_DOWNLOADS` | `disabled` → `free-testing-only` | Free public releases only. Licensed and paid files stay off for everyone (no `HCG_STORE_LAUNCH_APPROVED`) |
| `HCG_STORE_FREE_TESTING_APPROVED` | `founder-approved` | Required for the above in production |
| `HCG_STORE_ANONYMOUS_FREE_PRODUCTS` | `hcg-mail` (new) | HCG Mail's free public files download without an HCG account |
| `HCG_STORE_ANONYMOUS_FREE_APPROVED` | `founder-approved` (new) | Required for the above in production |
| `HCG_STORE_PAYMENT_PROVIDER` | `none` (unchanged) | No payments |

**Security implications.**
- **Downloads are not tied to accounts.** Downloads without an account are not linked to anyone, and the Store keeps
  no download log per person.
- **Bandwidth.** Fly.io bandwidth for HCG Mail downloads is open to anyone. Each address is limited to 20 file
  requests a minute, and the server returns 429 above that.
- **Which files can be served.** Only files that are, at the moment of the request:
  - published;
  - approved as public **and** free;
  - current for their platform;
  - available;
  - verified.

  Withdrawn, disabled, revoked, superseded and private files are never served this way. Every other product still
  needs an account, and gets nothing until it is in `HCG_STORE_PUBLICATION_PRODUCTS`.
- **Rolling back.** Remove the two `ANONYMOUS` lines to require accounts again. Withdraw or disable the release in
  Release Manager to stop all delivery at once.

## 5. Steps (in order)

1. **Merge and deploy** (operator, `mode=deploy`). The deploy runs:
   - the tests;
   - the migration dry run;
   - a pre-deploy backup;
   - the deployment itself;
   - the smoke test.

   Nothing becomes downloadable until a person publishes.
2. **Founder, in HCG ERP (Owner):**
   - make sure the feature `store.release.publish` exists on `hcg.store`;
   - grant it to your account, along with `store.publish` and `store.release.approve`.
3. **Founder:** sign in to HCG Store once. **Operator:** `mode=evidence` gives that sign-in's 12-hex `session_ref`.
4. **Operator: import** (`mode=import-release`):
   ```json
   {"request":"hcg-mail-windows-1.0.0-beta.1.json","authorised_by":"<founder's words>"}
   ```
   - The run downloads the asset from the GitHub release.
   - It checks the tag commit, the pinned SHA-256, GitHub's digest and the size.
   - It imports the file unchanged as a private draft.
5. **Operator: founder exception** (`mode=release-exception`, `command: grant`, with the `rel-…` from step 4 and the
   `session_ref` from step 3). The founder then submits, approves and publishes this release personally. The
   exception is audited and shown as "not an independent review".
6. **Founder, in the browser:** go to Release Manager → HCG Mail 1.0.0-beta.1, then:
   1. **Submit**.
   2. **Approve**: `public`, make current, type `1.0.0-beta.1`.
   3. **Publish**: type `1.0.0-beta.1`.
7. **Verify on the live site, signed out:**
   - the product page shows the Windows download card;
   - the download's SHA-256 matches;
   - a payment is never asked for;
   - the release resolution says `free-public`;
   - no other product changed.
8. **Catalogue:** `npm run releases:sync -- --production` writes the `releases.json` entry. Merge it and deploy.
