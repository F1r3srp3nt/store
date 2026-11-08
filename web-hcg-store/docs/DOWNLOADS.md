# Downloads

## Provider model

Downloads go through a `DownloadProvider` (`src/downloads/providers.ts`). Each provider turns a catalogue
URL into a browser navigation target and supplies a public disclosure text. Dropbox is the only provider
today. Adding another (e.g. a future HCG private-delivery service) means adding a provider and extending
`DOWNLOAD_PROVIDER_IDS`. The UI does not change.

## Dropbox shared-file links

`src/downloads/dropbox.ts` accepts a link only when **all** of these hold:

| Rule | Rejected examples |
|---|---|
| Parses as an absolute URL | `dropbox.com/scl/…`, `//www.dropbox.com/…` |
| No whitespace, control characters or backslashes | `https://evil.example\@www.dropbox.com/…` |
| Protocol is `https:` | `http:`, `ftp:`, `javascript:`, `data:` |
| No user name or password | `https://www.dropbox.com@evil.example/…`, `https://u:p@www.dropbox.com/…` |
| No explicit port | `https://www.dropbox.com:8443/…` |
| Host is exactly `www.dropbox.com` or `dropbox.com` | `www.dropbox.com.evil.example`, `evil-dropbox.com`, `dropbox.co`, `www.dropbox.com.` (trailing dot), IDN homographs, `dl.dropboxusercontent.com` |
| Path is a shared **file**: `/scl/fi/<id>/<name>` or legacy `/s/<id>/<name>` | folders (`/scl/fo/…`, `/sh/…`), `/home/…`, extra path segments |
| `/scl/fi/` links carry a non-empty `rlkey` | link without `rlkey` |
| At most 2048 characters | |

Accepted links are normalised by:

- setting `dl=1`, which replaces any `dl=0` and duplicates;
- removing `raw` (`raw=1` renders in the browser instead of downloading);
- **keeping** `rlkey`, `st`, `e` and every other parameter;
- dropping any `#fragment`.

The validator also warns when the file name in the link differs from the catalogue `fileName`, when no
SHA-256 is published, or when the size is missing.

## What happens on click

- The button is an ordinary `<a href>` to the Dropbox URL. It has no `download` attribute (that is
  ignored cross-origin anyway). The file is never fetched into page memory.
- The browser follows Dropbox's redirect and saves the file. The HCG Store page stays open.
- The page then says **"Download requested from Dropbox"**. HCG Store cannot see whether the transfer
  finished, and it never claims that anything was installed.
- Withdrawn releases never render a download link.

## Platform guidance

`src/domain/install-guidance.ts` holds per-format instructions. They are deliberately conservative:

- they never tell users to disable SmartScreen, Gatekeeper, SIP or any other protection;
- for `.ipa`, they state that **downloading an IPA does not install it on an iPhone or iPad**;
- for `.apk`, there is no guidance until HCG chooses a distribution route.

## Limitation: public links are public

A Dropbox shared link is a bearer link. **Anyone who has it can download the file**, and it can be copied
and shared outside HCG Store. Putting an HCG login in front of the button **would not** make the file
private, because the underlying URL stays public.

Consequences:

- Only publish files that are acceptable to be public.
- To revoke access, disable or regenerate the link in Dropbox, then update `releases.json`.
- Licensed, organisation-restricted or paid software needs **separate private delivery**: a backend,
  authorised by HCG ERP / App Access, that issues short-lived download URLs after checking permissions on
  the server. That is future work. It is out of scope for this storefront and must not be simulated in the
  browser.

## Dropbox availability caveats

Dropbox may throttle heavily used shared links or show an interstitial page instead of the file. Re-run
`npm run verify:artifact` if users report problems. Moving to a dedicated distribution host later only
needs a new provider.
