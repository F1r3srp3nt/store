# Public release resolution (for product websites such as HCG Trading)

A versioned, read-only interface that tells a website which approved release of a product is current, and how each
of its files is obtained **through HCG Store**. Implemented in `server/src/release-resolution.ts`; tested in
`server/test/release-import.test.ts`.

```
GET /api/public/v1/release-resolution/<product id or slug>[?platform=<id>&arch=<arch>]
```

- `platform`: a catalogue platform ID (`windows`, `macos`, `linux`, `ios`, `ipados`, `android`, `web`, `other`).
- `arch`: an architecture name such as `arm64` or `x64`.
- **CORS:** `Access-Control-Allow-Origin: *`. No cookies or credentials are used, so any website may call it.
- **Caching:** `Cache-Control: public, max-age=60`.
- **Errors:** `404 not_found` for an unknown or draft product; `400 bad_platform` or `400 bad_arch` for a bad filter.

## Response (format `hcg.store.release-resolution/1`)

```json
{
  "format": "hcg.store.release-resolution/1",
  "generatedAt": "…",
  "product": { "id": "…", "slug": "…", "name": "…", "summary": "…", "developmentStatus": "…",
               "productUrl": "<store origin>/apps/<slug>", "platforms": [{ "platform": "macos", "support": "…" }] },
  "releases": [ { "id": "rel-…", "version": "…", "build": "…", "channel": "beta", "releaseDate": "YYYY-MM-DD",
                  "releaseNotes": ["…"], "knownLimitations": ["…"], "source": "hcg-store-publication" } ],
  "options": [ { "releaseId": "rel-…", "editionId": "…", "editionName": "…", "platform": "macos", "architectures": ["arm64"],
                 "format": "dmg", "kind": "installer", "fileName": "…", "sizeBytes": 0, "sha256": "…",
                 "minimumOs": "…", "signing": "unsigned",
                 "access": { "kind": "free-testing", "requiresHcgAccount": true, "freeUntil": "…" },
                 "getUrl": "<store origin>/apps/<slug>?edition=…" } ],
  "filter": { "platform": "macos", "arch": "arm64" },
  "note": "Downloads happen on the product page with an HCG account and HCG Store's access checks. …"
}
```

### Which release is current

The current release is one of these, in this order:

1. The release a person approved with *make current* and then published in HCG Store
   (`source: "hcg-store-publication"`). This is live: no redeploy is needed.
2. The catalogue's explicit `currentReleaseId` (`source: "catalogue"`), used only when there is no such release.

The interface never infers "latest" from version numbers. These never appear:
- drafts;
- submitted releases;
- approved releases that are not yet published;
- withdrawn releases;
- superseded releases.

### `access.kind`

This is the same public information the product page shows:

| `access.kind` | Meaning |
|---|---|
| `free-testing` | Free during an open testing window, until `freeUntil`. Needs an HCG account. |
| `free-with-account` | A permanently free edition. Needs an HCG account. |
| `licence-required` | A paid release that only an owner can download. |
| `not-available-yet` | Downloads are not open, for example because no testing window is open. |

### What is never exposed

- File locations or download URLs.
- Storage keys or internal artifact IDs.
- Account, purchase or audit data.

`getUrl` is the product page. Sign-in, the ownership or free-window check and the delivery all happen there, so a
website can neither grant nor bypass access.

## HCG Trading (trading.hakmicapitalgroup.com)

The macOS trading simulator is **HCG ONE: Unleashed** (catalogue `hcg-one-unleashed`, central ID
`hcg.one.unleashed`). Its state on 26 November 2026:
- It is a development build (milestone M2, stage 2).
- Its repository has no CI workflow, tags, or built or approved release.
- Developer ID signing and notarization are planned for its milestone M6.

The interface therefore correctly returns `releases: []` and `options: []` for this product today. The website should
show "not released yet" in that case, and no download button.

To make a release appear:
1. Build a macOS ARM64 artifact (a DMG, or a ZIP of the .app) with a Release Passport, in CI or with HCG Executable
   Maker.
2. Import or upload it to HCG Store as a draft.
3. Submit it, approve it as public with *make current*, then publish it.
4. Optionally, open a free testing window.

The option then appears with no change to the website.

Example for the website (no credentials):

```js
const r = await fetch("https://store.hakmicapitalgroup.com/api/public/v1/release-resolution/hcg-one-unleashed?platform=macos&arch=arm64");
const data = await r.json();
const option = data.options[0];
if (!option) showNotReleasedYet(data.product.productUrl);
else showDownload({ href: option.getUrl, version: data.releases[0].version, size: option.sizeBytes,
                    sha256: option.sha256, unsigned: option.signing === "unsigned", access: option.access });
```

## Versioning

Fields may be added within `/v1`. Removing or changing a field needs `/v2`, which is served alongside `/v1` until
every website has moved.
