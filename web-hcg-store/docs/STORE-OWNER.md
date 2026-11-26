# HCG Store: founding Owner, roles and permissions

HCG Store keeps **no roles, permission table or admin accounts of its own**. Central HCG (ERP) is the only authority
for who may do what; HCG Store enforces HCG's decisions server-side on every request. This document says what the
founding Owner has, where each right lives, and how to grant and revoke it. It contains no secrets, e-mail addresses
or full account IDs.

## Identity

The founder signs in with their existing HCG Connect account. HCG Store identifies every account only by its
immutable HCG subject (`sub`), taken from tokens it verifies against HCG's keys and confirmed with HCG's `/me` at
sign-in. No second login exists, the account's e-mail is never changed by the Store, and nothing is decided by an
e-mail address or a name sent by a browser.

## Where each Owner right lives

| Right | Authority | How it is exercised | Enforcement |
| --- | --- | --- | --- |
| Manage users, organisations, roles and permission grants | Central HCG: the platform **Owner** role (ERP Owner workflows) | ERP, signed in as the Owner | Main site (Owner-only database functions, audited) |
| Register OAuth clients, products, features | Central HCG Owner | ERP → App integrations | Main site |
| Publish to HCG Store (`store.publish` on `hcg.store`) | Central personal grant | ERP → App Integrations → HCG Store → Feature access → Personal publishing and approval permissions | HCG Store asks HCG's `/check` on every publishing action |
| Approve releases (`store.release.approve` on `hcg.store`) | Central personal grant | same ERP page | `/check` on every approval, **plus** Store's different-person rule for public releases: the approver is neither the release's creator nor its submitter, unless a founder-operated exception is recorded for that exact release |
| Publish approved releases (`store.release.publish` on `hcg.store`) | Central personal grant (separate feature; HCG must create it) | same ERP page | `/check` on every publication; browser only; same different-person rule |
| Import a CI-built release (operator) | Repository and Fly.io access (operator), not a central grant | Actions → *Deploy Store server to Fly.io*, `mode=import-release` | Files verified byte-for-byte against the CI draft and Release Passports; result is a private **draft**, submitted afterwards by a person with `store.publish`; the CI build is recorded as creator and never counts as a reviewer |
| Founder-operated release exception (operator) | Repository and Fly.io access, with the founder's written authorisation | `mode=release-exception` | One person, one release, its exact file set (digest); hash-chained audit; revocable; never a permission |
| Use products and features (customer access) | Central licences per product and edition (D2), separate from purchases | ERP licences for the Owner's organisation, of an internal/owner type, never a payment record | `/check` (`feature_key: "download"` once D3 registers it) at every download |
| Catalogue, offers, release records, Store configuration | This repository and its deployment (`catalogue/*.json`, `server/data/offers.json`, `fly.toml`), changed by reviewed PRs and deployed from `main` | GitHub and Fly.io accounts held by the founder | Server validates at start; release records are generated from Store approvals |
| Display name and designation in HCG Store | **Presentation only**, not a right | Operator command on the server (below) | Read only for display; no permission check reads it |

"Owner" in HCG Store therefore means: the central HCG Owner, holding HCG's personal Store grants, with operator access
to the repository and the Fly.io app. There is no Store-side "owner" flag that could be switched on by anyone.

## Store profile (display name and designation)

`server/src/profiles.ts`: one row per verified HCG subject with a display name and a designation (for example
"Founder / Original User"). It **grants nothing**: no route, permission check, entitlement or approval rule reads
it. It does not change registration dates, history or ordering.

- **Set only server-side**: Actions → *Deploy Store server to Fly.io*, `mode=profile`, with the 12-hex reference of a
  sign-in that HCG Store verified and matched with HCG's `/me` (`mode=evidence` lists them), the display name, the
  designation and who authorised it. The run records itself as the performer. No HTTP route writes a profile.
- **Idempotent**: the same values again change nothing and record nothing.
- **Audited**: `store_profile_events` (append-only; database triggers refuse update and delete) holds the time,
  before and after values, who authorised and who performed each change.

## Granting and revoking (central)

1. ERP → App Integrations → HCG Store → Feature access → Personal publishing and approval permissions.
2. Select the organisation and the person's existing HCG user ID; select exactly `hcg.store · store.publish`,
   `hcg.store · store.release.approve` or `hcg.store · store.release.publish`; **Assign to this person**. **Revoke**
   beside an active grant removes it.
3. HCG Store re-checks on every action and never caches a yes, so a revocation applies to the next request.

The features stay **disabled** centrally until publishing is activated (PUBLISHING.md §7); holding a grant does not
enable an unfinished service. Public approval and publication always need a person other than the release's creator
and other than the person who submitted it. A CI build never counts as a person: a release imported from CI
(`mode=import-release`) stays a draft until someone with `store.publish` submits it, and that submitter may not approve
or publish it. The only exception is a **founder-operated release exception** (server/src/release-exceptions.ts,
`mode=release-exception`): recorded by the operator path with the founder's written authorisation, for one named
account (a verified sign-in reference), one release and its exact files. It is shown on the review page, recorded on
the approval and publication as `independentReview: false`, stops applying if any file changes, can be revoked, and is
never a permission (each step still needs its own central grant). It is prepared for HCG Mail for Windows
0.1.0-beta.1 only (docs/RELEASE-HCG-MAIL-0.1.0-beta.1.md).

## Founder product ownership (central, live)

HCG's main site published the shared product-access API on 18 Nov 2026 (main-site
`docs/hcg-connect/shared-product-access-handoff.md`). The Founder's account holds the Owner-audited policy
`founder_owner_all_products`: every registered HCG product, edition and feature, including products registered
later. It is attached to the account's user ID, creates no purchase, licence or billing record, grants no ERP or admin
role, does not make a planned product available or enable a disabled feature, and does not bypass Store's
different-person approval rule. It is activated and revoked only in ERP → App Integrations → HCG Connect / HCG Auth →
Founder product ownership, with a `founder.product_access.grant` audit event.

How HCG Store reads it (server-side, with the account's own HCG token; `server/src/entitlements.ts`):
- `GET /me`: `product_policy` (`active`, `policy_key: "founder_owner_all_products"`) and the account's `display_name`.
  The Store shows "Owner access — All features" only when this is active.
- `GET /library`: `founder_ownership` (every registered product for the Founder) and licence `items`.
- `GET /access?product=<id>` (Founder) or `&org=<organisation>` (ordinary accounts, per organisation they belong to):
  each product's ownership kind, entitlement source, editions, features and HCG `release_status`. A product shows
  "Owner access — All features" with source "Founder / Owner grant" only when its own answer says
  `ownership.kind: "founder_owner"` and `entitlement_source: "founder_owner_all_products"` (`parseAccess`).
- `POST /check` still decides every protected action at the moment it happens.

## My HCG apps (Account page)

`GET /api/v1/my-apps` (signed in), shown as "My HCG apps": one entry per registered product (for the Founder, HCG's
whole registry; for others, the Store's products and any they hold a licence for), with its icon (a monogram for apps
not in the Store), access state, editions, features, entitlement source, HCG's release status and HCG Store's release
availability (shown separately), and the actions that actually exist:
- **Open** (the product page) always; **Download** only when a release is approved, downloads are switched on and HCG
  reports access; **Manage in HCG** (the HCG account portal) when the account has access.
- Sources: "Founder / Owner grant" (`founder_owner_all_products`), "Organisation licence", "Purchased in HCG Store"
  (an organisation licence from a verified Store purchase), "Personal grant", "App access", "Included for every HCG
  account". Owner access is never shown as "Purchased".
- Each view records a token-free `my_apps_viewed` audit event with counts only (no product list, no account ID).
- Unreleased apps say "Not released yet", whatever the access.

## Verified behaviour

`server/test/profiles.test.ts`, `server/test/publishing.test.ts`, `server/test/ecosystem.test.ts`:
- a founder profile, a founder name or e-mail, extra JSON fields and headers never permit publishing or approval;
- there is no HTTP route that writes a profile, a role or a grant;
- permissions come only from HCG's grants on `hcg.store`; a grant on another product, ownership or a role never counts;
- revoking a grant takes effect on the next request;
- the profile audit cannot be altered;
- My HCG apps (`server/test/my-apps.test.ts`, `e2e/account.spec.ts`) against a mock with the handoff's exact response
  shapes: the Founder sees every registry product as Owner access with source "Founder / Owner grant", no organisation
  sent and no purchase record; ordinary accounts are asked per organisation and see only their own licence; a founder
  name, e-mail or profile grants nothing; an answer for another product or with another source is not accepted;
  revocation shows on the next load; no horizontal overflow at 390px.

The main site's own acceptance (17 Nov 2026) covers the ERP side: an ordinary licensed member without a personal grant
is refused, only the Owner can assign or revoke, and both are audited.
