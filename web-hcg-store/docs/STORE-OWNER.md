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
| Approve releases (`store.release.approve` on `hcg.store`) | Central personal grant | same ERP page | `/check` on every approval, **plus** Store's different-person rule for public releases (never bypassed, also for the Owner) |
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
2. Select the organisation and the person's existing HCG user ID; select exactly `hcg.store · store.publish` or
   `hcg.store · store.release.approve`; **Assign to this person**. **Revoke** beside an active grant removes it.
3. HCG Store re-checks on every action and never caches a yes, so a revocation applies to the next request.

The features stay **disabled** centrally until publishing is activated (PUBLISHING.md §7); holding a grant does not
enable an unfinished service. Public approval always needs a second, different person with `store.release.approve`.

## Verified behaviour

`server/test/profiles.test.ts`, `server/test/publishing.test.ts`, `server/test/ecosystem.test.ts`:
- a founder profile, a founder name or e-mail, extra JSON fields and headers never permit publishing or approval;
- there is no HTTP route that writes a profile, a role or a grant;
- permissions come only from HCG's grants on `hcg.store`; a grant on another product, ownership or a role never counts;
- revoking a grant takes effect on the next request;
- the profile audit cannot be altered.

The main site's own acceptance (17 Nov 2026) covers the ERP side: an ordinary licensed member without a personal grant
is refused, only the Owner can assign or revoke, and both are audited.
