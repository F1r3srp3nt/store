# Production: HCG Store on Fly.io

How to publish HCG Store at **https://store.hakmicapitalgroup.com** as one HCG Store server that serves both the
storefront and its same-origin `/auth/*`, `/api/*` and `/repo-api/*` routes. Each capability is enabled in its own
phase, only after the previous one is verified:

| Phase | Turns on | Switch in `fly.toml` |
| --- | --- | --- |
| 1 | The server, without sign-in; the address moves from GitHub Pages | none |
| 2 | HCG Connect sign-in | the `HCG_CONNECT_*` block |
| 3 | Ship to Store publishing (Executable Maker uploads, manual approval) | `HCG_STORE_PUBLISHING` and its block |
| 4 | Customer payments and protected downloads | `HCG_STORE_PAYMENT_PROVIDER`, `HCG_STORE_PROTECTED_DOWNLOADS` (ACCESS.md launch conditions) |

## Where things run today (observed 16 Nov 2026, 22:50 UTC)

| What | Where | Evidence |
| --- | --- | --- |
| Storefront (static build of `main`, 7f04ab7) | GitHub Pages at `store.hakmicapitalgroup.com` | `server: GitHub.com`; `GET /api/v1/health` answers the site's 404 page |
| HCG Store server (sign-in, sessions, publishing, delivery) | **Nowhere** | `hcg-store.fly.dev` does not answer; no other host exists |
| HCG Repo | GitHub Pages at `repo.hakmicapitalgroup.com` | public metadata only; `payment_endpoint` empty |

So today the storefront is deployed and the server is not. After phase 1 both come from one Fly.io app, at the same
address.

## Why Fly.io

| Option | Can it run the Store server? |
| --- | --- |
| GitHub Pages (today's storefront) | No. Static files only. |
| Main HCG site (Lovable, `beta.hakmicapitalgroup.com`) | No. It serves the main site's own app. |
| HCG's Supabase project | No. Deno edge functions; the Store server is a long-running Node process with a SQLite file and private files. |
| **Fly.io** | **Yes.** Runs the Store's container with a persistent volume, managed TLS for the custom domain, secrets, health checks, restarts and volume snapshots. |

What the server needs, and how the Fly.io setup provides it:

| Need | Provided by |
| --- | --- |
| Node 22.5+ (`node:sqlite`), one long-running process | `Dockerfile` (Node 22.23.4, production dependencies, unprivileged `node` user) |
| One writer for SQLite: exactly one machine | `min_machines_running = 1`, `auto_stop_machines = "off"`; never scale above one |
| Persistent database and private files | Volume `hcg_store_data` at `/data`: database `/data/hcg-store.sqlite`, files `/data/artifacts` (outside the static root `dist/`) |
| Uploads up to 2 GB per file | `HCG_STORE_UPLOAD_MAX_MB = 2048`; 3 GB volume growing by 1 GB at 80 % up to 20 GB |
| HTTPS on the custom domain, same origin | Fly TLS certificate for `store.hakmicapitalgroup.com`, `force_https`; the server serves the storefront and its routes |
| Health checks and restarts | `GET /api/v1/health` every 15 s; `[[restart]] policy = "always"`; SIGTERM clean stop (requests finish, database closes) |
| Backups | Daily consistent database copies plus Fly's daily volume snapshots; see Backups |
| Outbound HTTPS | HCG Connect (`qggdyzoydveafkmjgkpq.supabase.co`) and HCG's Ecosystem API (`beta.hakmicapitalgroup.com`) |

## Cost (Fly.io pricing page, read 16 Nov 2026)

| Item | Price |
| --- | --- |
| shared-cpu-1x 512 MB, always on, Stockholm (`arn`) | $3.69/month base × 1.038 ≈ **$3.83/month** |
| Volume, 3 GB at the start | $0.15/GB/month = **$0.45/month** (at the 20 GB limit: $3.00) |
| Volume snapshots | $0.08/GB/month; the first 10 GB each month are free |
| TLS certificate for one hostname | free (first 10) |
| Shared IPv4 and IPv6 | free |
| Outbound data, Europe | $0.02/GB |
| **Expected at the start** | **about $4.30/month** |

New accounts get a $1 trial credit for 7 days, then need a credit card. Fly.io's pricing page also says a personal
organisation's monthly bill under $5 is waived; do not rely on that staying true.

## What is missing before anything can be deployed

| # | Missing | Who | Exactly |
| --- | --- | --- | --- |
| A | A Fly.io account with a payment method | founder | `fly auth signup` (or login), card in the dashboard. Nothing in this repository or its build environment has Fly access. |
| B | Write access to the DNS of `hakmicapitalgroup.com` | founder | Two changes only: add the `_acme-challenge.store` record that `fly certs add` prints, then change the `store` record. The DNS provider was not identified from here; it is whoever hosts the zone (the domain previously used Domene). |
| C | GitHub settings, only to deploy from Actions | founder | Environment `production` with secret `FLY_API_TOKEN` (`fly tokens create deploy --app hcg-store`); repository variable `STORE_HOSTING=fly` at cutover. Deploying from the Mac with `fly deploy` needs neither. |
| D | HCG Store's **production** HCG Connect client | HCG (Owner) | After phase 1; request below. The development client is refused in production. |
| E | `store.publish` and `store.release.approve` as per-product features with per-person grants; a second eligible approver | HCG (Owner) | Phase 3; see PUBLISHING.md §7. |

## Production configuration

Non-secret settings are in `fly.toml` `[env]`, reviewed in Git. The one secret is `HCG_STORE_SECRET_KEY` (32 random
bytes that seal stored HCG tokens and sign short-lived links), set with `fly secrets` and never written to a file, Git
or a log. Changing it signs everyone out and invalidates issued links; nothing else is lost. Later phases add
secrets the same way (payment provider keys, the HCG grant credential), never in `fly.toml`.

| Setting | Value |
| --- | --- |
| `HCG_STORE_MODE` | `production`: refuses test payments, test ledgers, development clients and an `http` origin |
| `HCG_STORE_PUBLIC_ORIGIN` | `https://store.hakmicapitalgroup.com`: session cookie `__Host-…`, `Secure`, `HttpOnly`, `SameSite=Lax` |
| `HCG_STORE_DATA_DIR`, `HCG_STORE_ARTIFACT_STORAGE_DIR` | `/data`, `/data/artifacts` (the volume) |
| `HCG_STORE_BACKUP_DIR`, `HCG_STORE_BACKUP_KEEP` | `/data/backups`, 14 |
| Payments, downloads, publishing | `none`, `disabled`, `disabled` |
| HCG Connect (phase 2) | commented block with the production client |
| Publishing (phase 3) | commented block: Executable Maker's production client `fb9b6edf-2bfc-4b5e-a354-dbb1af697029`, `store.publish`, `store.release.approve` |

Logs never contain tokens, codes or cookies. `server-dist/auth-evidence.mjs` prints the sign-in audit trail, session
token-column states and the publishing audit, without token values; `server-dist/release-records.mjs` prints the
approved release records. Both open the database read-only.

## Backups

1. **Consistent database copies.** The server writes `VACUUM INTO` copies to `/data/backups` one minute after start and
   then daily, mode 0600, keeping the newest 14. A copy is always a complete database, even if the volume snapshot
   catches SQLite mid-write.
2. **Volume snapshots.** Fly snapshots the whole volume (database, copies and private files) daily, kept 14 days
   (`snapshot_retention = 14`). Restore: `fly volumes snapshots list <volume id>`, then
   `fly volumes create hcg_store_data --snapshot-id <id> --region arn` and redeploy.
3. **Off-host copy.** Fly's own guidance is that a single volume with daily snapshots is not enough for data that
   changes often. Until an automated off-host target is approved (a cost decision), copy the newest backup to the Mac
   weekly and before every deploy. List the copies, then fetch the newest by name:

```bash
fly ssh console --app hcg-store --command "ls -1 /data/backups"
```

```bash
fly ssh sftp get --app hcg-store /data/backups/<newest file name>
```

Before phase 3 (publishing: approved files and the audit) and phase 4 (payments), decide on automated off-host
backups. The backup files hold account IDs, e-mail addresses, sealed tokens, purchases and the publishing audit: keep
them private.

## Fastest path to working sign-in (phases 0–2 only)

Publishing, approvers, payments, downloads and HCG Repo are not needed for sign-in.

| Step | Who | What |
| --- | --- | --- |
| 1 | founder | Fly.io account with a card; an org token in the repository secret `FLY_API_TOKEN` (commands below) |
| 2 | Claude | Actions → *Deploy Store server to Fly.io*, `mode=deploy`: creates the app, volume and session key if missing, deploys one Machine, requests the certificate, smoke-tests `hcg-store.fly.dev`, and prints the DNS records Fly needs |
| 3 | founder | DNS: the records from step 2 (`store` → `hcg-store.fly.dev`, and `_acme-challenge.store`); repository variable `STORE_HOSTING=fly` |
| 4 | founder → HCG | the production client request (2.1); HCG sends back the client ID |
| 5 | Claude | put the client ID into `fly.toml`, deploy, then verify with `mode=evidence` and `mode=restart` while the founder signs in from a phone |

Step 1, on the Mac:

```bash
brew install flyctl
```

```bash
fly auth signup
```

```bash
fly tokens create org --name "hcg-store github actions" --expiry 8760h
```

Copy the whole output (it starts with `FlyV1 `) into GitHub → `F1r3srp3nt/store` → Settings → Secrets and variables →
Actions → New repository secret, name `FLY_API_TOKEN`. The token never needs to be shown to anyone else. After the
first deploy it can be replaced by an app-only token (`fly tokens create deploy --app hcg-store`).

The phases below are the same steps done by hand from the Mac.

## Phase 0: once, on the Mac

```bash
brew install flyctl
```

```bash
fly auth login
```

Add a payment method in the Fly dashboard.

## Phase 1: the server without sign-in, then the address

Run these in `store/web-hcg-store` on `main` after the deployment PR is merged. Phase 1 does not touch the live site
until step 1.4.

1.1 Create the app, volume and secret:

```bash
fly apps create hcg-store
```

```bash
fly volumes create hcg_store_data --app hcg-store --region arn --size 3 --snapshot-retention 14
```

```bash
printf 'HCG_STORE_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" | fly secrets import --app hcg-store
```

1.2 Deploy and check it on its Fly address:

```bash
fly deploy --build-arg GITHUB_SHA=$(git rev-parse HEAD)
```

```bash
node scripts/smoke-deployment.mjs https://hcg-store.fly.dev/ --expect-commit $(git rev-parse HEAD)
```

Expect `SMOKE OK`; `/api/v1/health` shows `"mode":"production"`, `"hcgConnect":"not-configured"`, payments and
downloads `disabled`.

1.3 Issue the certificate before moving DNS:

```bash
fly certs add store.hakmicapitalgroup.com --app hcg-store
```

Add **only** the `_acme-challenge.store` record it prints. Wait until this reports the certificate as issued:

```bash
fly certs check store.hakmicapitalgroup.com --app hcg-store
```

1.4 Cut over:
1. Write down the current `store` record exactly (type, value, TTL): it is the rollback value.
2. Change `store` to what `fly certs add` showed (a CNAME to `hcg-store.fly.dev`, or the A and AAAA values from
   `fly ips list --app hcg-store`). Change nothing else.
3. Set the repository variable `STORE_HOSTING` = `fly`. Pages deploys stop; leave the Pages settings and `CNAME` file
   for rollback.
4. Repeat until it passes:

```bash
node scripts/smoke-deployment.mjs https://store.hakmicapitalgroup.com/ --expect-commit $(git rev-parse HEAD)
```

**Phase 1 is verified when** that smoke test passes on the public address and `curl -sI
https://store.hakmicapitalgroup.com/` shows `fly-request-id`, not `server: GitHub.com`.

## Phase 2: sign-in

2.1 Send main HCG this request:

> Please issue a **dedicated production** HCG Connect client for HCG Store through the Owner workflow (ERP → App
> integrations → Inspect registrations → Issue or reuse login client). Do not reuse the development client
> `af487795-ead1-4671-8b09-76301762ee2c`.
>
> | Field | Value |
> | --- | --- |
> | Product | `hcg.store` |
> | Integration key | `hcg-store-web-production` |
> | Environment | production |
> | Client type | public; token endpoint auth `none`; no secret |
> | Grants | `authorization_code`, `refresh_token` |
> | PKCE | S256 |
> | Scopes | `openid email profile` |
> | Access-token audience | `authenticated` |
> | Consent name | HCG Store |
> | Redirect URI (exact) | `https://store.hakmicapitalgroup.com/auth/callback` |
> | Allowed origins | none (the Ecosystem API is called server to server) |
> | Logout return URL | none |
> | Status | `configured_untested` until HCG Store sends the production evidence report |
>
> `https://store.hakmicapitalgroup.com` is served by the HCG Store server (Fly.io, Stockholm);
> `GET https://store.hakmicapitalgroup.com/api/v1/health` returns its status. Send back the client ID only.

2.2 Uncomment the HCG Connect block in `fly.toml`, put in the issued client ID, merge, deploy (`fly deploy …` or
Actions → *Deploy Store server to Fly.io*).

2.3 Verify with a real account:

```bash
npm run hcg:dev:verify -- --production
```

| Check | Passes when |
| --- | --- |
| Real-account sign-in | `login_succeeded` for the production callback; PKCE S256, state and nonce verified |
| Account matching | `/me` returned the same account (`accountWithMe: true`); a different account is refused |
| Session restoration | the same session after `fly apps restart hcg-store` |
| Refresh | `session_refreshed` with the refresh token rotated |
| Logout | session ended, both stored tokens deleted. HCG Connect itself is not signed out (no end-session endpoint) |
| Unauthorized access | forged, missing and replayed state refused; invalid code refused; `/api/v1/library` without a session 401 |

Send the `.hcg-dev/evidence-production-*.md` report; ask HCG to mark the client verified only if every row passes.

## Phase 3: Ship to Store publishing

Only after phase 2 is verified and HCG has done E (PUBLISHING.md §7). Then uncomment the publishing block, set
`HCG_STORE_PUBLISHING = "enabled"`, deploy, and run these with Executable Maker (production client, Store address
`https://store.hakmicapitalgroup.com/`), two HCG accounts (publisher P, approver A) and a third account C that is a
member of the same HCG organisation **without** either grant:

| Check | How | Passes when |
| --- | --- | --- |
| Denied upload | C ships from Executable Maker | 403 `not_publisher`; no release created |
| Permitted upload | P ships a small signed build | draft release created; file `verified` |
| Resumable upload | P quits Executable Maker mid-upload and ships again | resumes at the confirmed byte; one release, no duplicate |
| Checksum verification | the Store's SHA-256 equals the build's | `artifact.verified` audit entry with the same SHA-256 |
| Private-draft isolation | C opens the review link; a signed-out browser opens it | 404 and 401; the file is not reachable |
| Manual approval | P tries to approve; A approves in the browser, typing the version | P refused (desktop: `manual_approval_required`; web, public: `separation_of_duties`); A succeeds |
| Authorized download | A uses *Download to review*; C asks for the file | A gets identical bytes (`approver-review`); C refused |
| Withdrawal | A withdraws the release | an already issued link stops working; the HCG Repo listing shows `withdrawn` |

Evidence: the Executable Maker log, and the publishing audit (with `auditIntact: true`) from

```bash
fly ssh console --app hcg-store --command "node --no-warnings server-dist/auth-evidence.mjs --since <ms>"
```

Then `npm run releases:sync -- --production` regenerates the catalogue's release records from the approvals.

## Phase 3a: Control Center (website uploads), proposed for founder review

Deploys the Control Center ([ADMINISTRATION.md](ADMINISTRATION.md)) into the running uploads-only Store. **No
`fly.toml` change**: `HCG_STORE_PUBLISHING` stays `uploads`, the publication key stays commented out, payments stay
`none`, protected downloads stay `disabled`. Optional: `HCG_STORE_ADMIN_RATE_PER_MINUTE` (default 300).

What the deploy changes:

- **Migrations 10 and 11.** Migration 10 adds release availability, revisions and the upload source, the
  per-target current-release table, and draft-product metadata. Migration 11 (Distribution Studio) adds the release's
  `publication_request`. Existing rows get `available`, revision 1. Current releases are backfilled only
  from published releases, and production has none, so the table starts empty. The release before this one runs
  unchanged on the migrated database (checked), so an image rollback needs no database restore.
- New routes: `/control-center`, `GET /api/v1/publishing/me`, `/changes`, `/products/:id` (GET, PATCH),
  `/releases/:id/{disable,enable,archive,revoke,supersede,restore,requests}`. The product list carries official
  metadata and artwork, and new capability flags let HCG Executable Maker's Distribution Studio find them.
  HCG Executable Maker 0.4.0 keeps working unchanged.
- **Every browser change to the publishing API now needs the session's CSRF token** (`X-HCG-CSRF`). The website and
  the review page send it. Desktop apps use bearer tokens and are unaffected.

Deploy: *Actions → Deploy Store server to Fly.io → mode `deploy`* on `main`. The workflow runs the tests, the
migration dry run on a copy of the live database, the pre-deploy backup, the deploy and the smoke test with the
expected commit, as for every deploy.

Verification by the founder (production, after deploy):

| Check | How | Passes when |
| --- | --- | --- |
| Deployed commit | `/hcg-build.json` | the merged commit |
| Mode | `/api/v1/health` | `"publishing":"uploads"`, payments and protected downloads `disabled` |
| Not authorised | a customer HCG account opens `/control-center` | "Not authorised"; no upload controls |
| Permissions | the founder opens `/control-center` | chips show *Private uploads only* and *Upload and submit ✓* (needs HCG's `store.publish` grant) |
| Website upload | *Add new update* → a listed product → a small installer | file `Verified`, SHA-256 equals `shasum -a 256 <file>` on the Mac |
| Resume | reload the tab during a large upload; *Continue a draft* → choose the same file | continues from the bytes already received |
| Same draft in the apps | open Release Manager in HCG Executable Maker or Store Manager | the same release, revision and SHA-256 |
| Submit | *Submit for review* | `submitted` |
| Publication stays off | the Releases tab | no Approve or Publish buttons. The API answers `publication_disabled`. |
| Customer delivery stays off | `/api/v1/downloads/<file>` as a customer | refused |

Rollback: `fly deploy --image <previous>` (see Rollback). Uploaded drafts stay in the database and storage either way.

## Phase 4: customer payments and downloads

Separate from publishing, and only when every launch condition in [ACCESS.md](ACCESS.md) holds and the founder
approves: a payment provider with verified webhooks, the HCG grant credential (D5) and HCG's edition and `download`
feature checks (D2, D3). Checkout redirects and browser flags never unlock anything; only signature-verified payment
events, through the idempotent grant/revoke outbox, do.

## Rollback

| Problem | Action | Time |
| --- | --- | --- |
| A phase misbehaves | Comment its block in `fly.toml` out again (or set the switch back) and deploy. Earlier phases keep working. | ~3 min |
| A deploy breaks the server | `fly releases --app hcg-store --image` lists earlier images; `fly deploy --image <previous>` restores one | ~2 min |
| Data damaged | Restore a volume snapshot or a `/data/backups` copy (see Backups) | ~15 min |
| Fly itself is the problem | Set `store` back to the value written down in 1.4, delete `STORE_HOSTING`, re-run *Deploy storefront to GitHub Pages*. The static storefront returns without sign-in. | DNS TTL; GitHub may take a while to re-issue its certificate, as on 15 Nov |

## Status, kept separate

| Stage | Status |
| --- | --- |
| Merged code | Ship to Store (publishing) is on `main`. The production packaging, sign-in evidence, product-scoped permissions, release-record generation, HCG Repo companion changes, feature-carrying grants and backups are in the open deployment PR, not merged. |
| Built and run locally | The production image (earlier) and the built server with this `fly.toml`'s settings: health, smoke, clean stop, data kept across restart, a private backup written, publishing off by default, the development client refused for sign-in and publishing. |
| Deployed server | **None.** Needs phases 0–1 by the founder. |
| Verified production behaviour | **None.** Sign-in needs phase 2; publishing phase 3; payments and downloads phase 4. |
