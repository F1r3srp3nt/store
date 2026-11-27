# HCG Mail 1.0.0-beta.1 for macOS (Apple silicon): public beta

This release adds two macOS downloads to the HCG Mail product, next to the published Windows x64 release of the same
version (`rel-bc6c2096b73a977f`, which this release does not change):

| File | Kind | Edition |
|---|---|---|
| `HCG Mail.app.zip` | the app in a ZIP | `macos-desktop` |
| `HCG Mail-1.0.0-beta.1-osx-arm64.pkg` | installer package | `macos-desktop` |

The release is free permanently: the edition's `pricingModel` is `free`. It needs no account: HCG Mail is already in
`HCG_STORE_ANONYMOUS_FREE_PRODUCTS`. Payments stay off, and no production setting changes.

## 1. Status

**Not qualified yet.** HCG Mail's CI run 45961684897 (`macos-release.yml`, branch `macos/1.0.0-beta.1`, commit
`3284671`) completed with these results:
- The package and hardened-runtime test jobs succeeded.
- The **Developer ID job signed nothing**: it reported that signing is not configured. All eight inputs are missing:
  `APP_P12`, `APP_P12_PASSWORD`, `PKG_P12`, `PKG_P12_PASSWORD`, `NOTARY_KEY`, `NOTARY_KEY_ID`, `NOTARY_ISSUER` and
  `TEAM_ID`.
- The `verify-signed` and `evidence` jobs were skipped.
- The run's only files are ad-hoc test builds marked "TEST-not-for-distribution". HCG Store never imports them.

To qualify, the owner adds the Apple signing secrets to HCG Mail's `macos-signing` environment, as
`MACOS_DEVELOPER_ID_*`, `APPLE_NOTARY_API_*` and the variable `APPLE_TEAM_ID` (see HCG Mail's `docs/MACOS_SIGNING.md`).
Then they re-run the workflow. Run HCG Store's verification against the new run ID.

## 2. Never published

The two macOS files HCG Store verified and refused on 27 Nov 2026 are listed by SHA-256 in
`release-imports/rejected-artifacts.json`:
- `HCG.Mail.app.zip`, which has a broken ad-hoc signature;
- `HCG.Mail-1.0.0-osx-arm64.pkg`, which is unsigned.

Neither is notarized. They are refused everywhere, whatever their name:
- HCG Store's macOS verification workflow;
- the import verifier (`scripts/verify-release-import.py`);
- the operator import (`release-import-cli`);
- the server's import;
- any Control Center upload (`publishing.ts`).

## 3. HCG Store's own verification (read-only)

`.github/workflows/hcg-mail-macos-evidence.yml` is dispatched with the input `run_id`. It sends nothing to the
production Store and uses no secret.

1. **Status.** Reports the run's state, its jobs and the steps each job ran, the run's own notices, and its artifacts.
   It continues only when the signed files, the release manifest and the signing evidence all exist.
2. **On an Apple silicon runner (`macos-15`)**, independently of the run's own evidence, it checks:
   - every file's size and SHA-256 against the run's HCG Store draft and its Release Passport;
   - each passport against HCG Repo's schema (pinned commit `0c25d95`);
   - the draft's identity (`hcg-mail` / `macos-desktop`, beta, free);
   - the bundle ID, `CFBundleShortVersionString`, `CFBundleVersion` and minimum macOS from `Info.plist`;
   - `lipo -archs` is exactly `arm64`;
   - `codesign -dvvv`: Authority `Developer ID Application`, Team ID, hardened runtime;
   - `codesign --verify --deep --strict`;
   - quarantined download: `spctl -a -t exec` gives "accepted, source=Notarized Developer ID";
   - `stapler validate` on the app and on the PKG;
   - `pkgutil --check-signature` gives `Developer ID Installer`;
   - `spctl -a -t install` gives Notarized Developer ID;
   - the PKG's payload app is byte-identical to the ZIP's app;
   - no installer scripts;
   - HCG Mail runs for 20 seconds;
   - the rejected list.
3. **Candidate import request.** It writes `hcg-mail-macos-store-verification/candidate/hcg-mail-macos-1.0.0-beta.1.json`,
   pinning the verified SHA-256s.

## 4. The import request (reviewed, committed)

`release-imports/hcg-mail-macos-1.0.0-beta.1.json` is a `ci-run` request built from the candidate. It holds:
- `source`: the run ID, the commit, `filesArtifact: hcg-mail-macos-1.0.0-beta.1` and
  `draftArtifact: hcg-mail-macos-release-manifest`;
- `expect`: `macos-desktop`, `1.0.0-beta.1`, build `4`, beta, free, `platform: macos`, 2 files, and the exact SHA-256s.

It also holds three reviewed changes. None of them touches the bytes, sizes, hashes, platform, architecture, format,
kind or provenance:
- **`reviewedReleaseNotes`.** The run's notes call the release "free during testing (temporary; not a permanent free
  price)". The edition is permanently free.
- **`storeVerifiedSigning`.** It records `notarized` with the evidence of HCG Store's run in step 3, for a file the
  run reports as `signed`. It cannot upgrade an unsigned file.
- **`reviewedFileFields`.** It sets `minimumOs` to "macOS 11" (the run writes a sentence longer than 40 characters)
  and `package` to null (the run puts the bundle ID in the Debian-only field). Without these two, the import would
  refuse the run's draft.

## 5. Steps (in order)

1. **Merge and deploy** (operator, `mode=deploy`). The new code:
   - adds the `macos-desktop` edition;
   - allows file names with single inner spaces;
   - adds the `filename*` download header;
   - makes the launch page multi-platform;
   - adds the rejected list.

   Nothing changes on the site until a person publishes.
2. **Owner:** configure Developer ID signing for HCG Mail (section 1) and re-run `macos-release.yml`.
3. **Operator:** dispatch `hcg-mail-macos-evidence.yml` with the new `run_id`. Every check must pass. Commit the
   reviewed request (section 4).
4. **Operator: import** (`mode=import-release`):
   ```json
   {"request":"hcg-mail-macos-1.0.0-beta.1.json","authorised_by":"<founder's words>"}
   ```
   This downloads the run's two artifacts and verifies the request, the draft, `SHA256SUMS` and the passports again
   (`verify-release-import.py`). It then imports both files unchanged as one **private draft**.
5. **Founder:** sign in to HCG Store. **Operator:** `mode=evidence` gives the `session_ref`.
6. **Operator: founder exception, for this release only** (`mode=release-exception`):
   ```json
   {"command":"grant","release":"rel-<from step 4>","session_ref":"<from step 5>","reason":"HCG Mail 1.0.0-beta.1 for macOS (Apple silicon), founder-operated","authorised_by":"<founder's words>"}
   ```
   It is audited and shown as "not an independent review". Every other release keeps separation of duties.
7. **Founder, in Release Manager → HCG Mail 1.0.0-beta.1 (macOS desktop):**
   1. **Submit**.
   2. **Approve**: `public`, make current, type `1.0.0-beta.1`.
   3. **Publish**: type `1.0.0-beta.1`.

   "Current" applies per target, here (macOS desktop, macOS, arm64, beta). The Windows release stays current for its
   own target.
8. **Automatic once published:**
   - The product page offers macOS as "Available now", with both downloads (PKG first, then ZIP), each with its
     SHA-256 and `shasum -a 256` instructions.
   - Mac visitors get the macOS installer as the main download, with "Also available for Windows". Windows visitors
     keep the unchanged Windows file first.
   - "macOS · coming soon" disappears.
   - Each platform shows its own release notes and limitations.
   - Platform listings and cards show macOS as supported, with the published architecture and minimum OS.
   - The release history lists both releases.
   - The server-rendered head and the `SoftwareApplication` data name both operating systems.
9. **Verify on the live site, signed out:**
   - both macOS downloads, and their SHA-256 against the pinned values;
   - the Windows download is unchanged (`art-cdf727e41e4fb77d`, SHA-256 `0424c7c6…2fdf`);
   - the release resolution for macOS says `free-public`;
   - health reports `payments: disabled`;
   - no other product changed.
10. **Catalogue:** `releases:sync` from the production records (operator `mode=release-records`) adds the macOS entry
    to `releases.json`. The explicit `currentReleaseId` stays the founder's choice. Merge and deploy.

## 6. Rolling back

- Withdraw or disable the macOS release in Release Manager. Its two files stop downloading at once, and the Windows
  release is unaffected.
- Revoke the exception with `mode=release-exception` and `{"command":"revoke","id":"rx-…",…}`.
