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

## Owner access to every product (PROPOSED central policy)

HCG Store shows **"Owner access — All features"** only when HCG reports the policy below; until HCG builds it, the
Store shows exactly the licences HCG reports. HCG Store has no way to create this access itself, by design.

**What the main site would build** (an Owner-reviewed migration; not built yet):

1. **A personal policy, not a licence or a purchase.** One row per account: `policy = "owner_all_products"`,
   `source = "founder_owner_grant"`, granted and revoked only by the HCG Owner (Owner-only database function), keyed to
   the account's immutable user ID, with `owner_access.grant` / `owner_access.revoke` audit entries (actor, reason,
   time). No purchase or licence row is written, so payment records and licences stay untouched.
2. **All current and future products.** Evaluated when access is checked, so a product registered later is covered
   without a new grant.
3. **`/check` returns it consistently to every app.** For an account with active owner access, the licence and
   organisation layers are satisfied for every product and edition, with an additive response field
   `"basis": "owner_access"`. Unchanged:
   - **availability** still applies: a product or feature HCG has switched off stays off for everyone, so access
     never makes an unfinished integration operational;
   - **staff permissions** (`store.publish`, `store.release.approve` and any future personal-grant features) are not
     covered: they stay personal grants, and Store's different-person approval rule stays.
4. **`/library` reports it**, additively, so apps can show it:

```json
"owner_access": { "policy": "owner_all_products", "source": "founder_owner_grant", "status": "active",
                  "granted_at": "<ISO time>", "revoked_at": null }
```

HCG Store recognises only that exact form (`server/src/entitlements.ts`, `parseLibrary`): anything else, a revoked
policy, another source, or a `role`, `owner` or similar field, is ignored. Revocation shows on the next page load,
and every download is still decided by `/check` at the moment it is requested.

## My HCG apps (Account page)

`GET /api/v1/my-apps` (signed in), shown as "My HCG apps": one entry per registered product (registered first, then
products HCG has not registered yet) with its icon and name, access state, editions, features, entitlement source and
the actions that actually exist:
- **Open** (the product page) always; **Download** only when a release is approved, downloads are switched on and HCG
  reports access; **Manage in HCG** (the HCG account portal) when the account has access.
- Sources: "Founder / Owner grant" (the policy above), "Purchased in HCG Store" (a verified Store purchase),
  "HCG internal grant", "Licence (perpetual)", "Subscription" or "Trial" (from HCG's licence type). Owner access is
  never shown as "Purchased".
- Unreleased apps say "Not released yet", whatever the access.

## Verified behaviour

`server/test/profiles.test.ts`, `server/test/publishing.test.ts`, `server/test/ecosystem.test.ts`:
- a founder profile, a founder name or e-mail, extra JSON fields and headers never permit publishing or approval;
- there is no HTTP route that writes a profile, a role or a grant;
- permissions come only from HCG's grants on `hcg.store`; a grant on another product, ownership or a role never counts;
- revoking a grant takes effect on the next request;
- the profile audit cannot be altered;
- My HCG apps (`server/test/my-apps.test.ts`, `e2e/account.spec.ts`): Owner access covers every registered product with
  source "Founder / Owner grant" and no purchase record; ordinary accounts see only their own grants; a founder name,
  e-mail or profile grants nothing; only the exact, active policy counts; revocation applies on the next request; the
  section has no horizontal overflow at 390px.

The main site's own acceptance (17 Nov 2026) covers the ERP side: an ordinary licensed member without a personal grant
is refused, only the Owner can assign or revoke, and both are audited.
