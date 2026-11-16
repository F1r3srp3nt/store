# Production: HCG Store server on Fly.io

How to publish HCG Store's sign-in at **https://store.hakmicapitalgroup.com**: the same storefront,
now served by the HCG Store server so HCG Connect sign-in works. Payments, purchase grants and
protected downloads stay **off**; each needs its own end-to-end test and the founder's approval.

## Why a new host

| Option | Can it run the Store server? |
| --- | --- |
| GitHub Pages (today's storefront) | No. Static files only. |
| Main HCG site (Lovable, `beta.hakmicapitalgroup.com`) | No. Its hosting serves the main site's own app; it does not run other Node services. |
| HCG's Supabase project | No. Its functions are Deno edge functions; the Store server is a long-running Node process with a SQLite file. |
| **Fly.io** | **Yes.** Runs the Store's container with a persistent volume, managed TLS for a custom domain, secrets, health checks and automatic restarts. |

## Target

| Item | Value |
| --- | --- |
| App | `hcg-store` (`fly.toml`; choose another name if it is taken, and update `fly.toml` and the workflow) |
| Region | `arn`, Stockholm |
| Machine | 1 × shared-cpu-1x, 512 MB, always on (never auto-stopped: it owns the database) |
| Storage | Volume `hcg_store_data`, 1 GB, mounted at `/data` (SQLite) |
| Image | `web-hcg-store/Dockerfile`: Node 22.23.4, production dependencies only, runs as the unprivileged `node` user |
| HTTPS | Fly terminates TLS. `force_https` redirects http to https. Certificate for `store.hakmicapitalgroup.com` (free). |
| Health check | `GET /api/v1/health` every 15 s |
| Restarts | `[[restart]] policy = "always"`. SIGTERM triggers a clean stop: requests finish and the database closes. |
| Address before DNS | `https://hcg-store.fly.dev` |

### Cost (Fly.io pricing page, 16 Nov 2026)

| Item | Price |
| --- | --- |
| shared-cpu-1x 512 MB, always on | $3.69/month base; Stockholm ×1.038, about **$3.83/month** |
| Volume, 1 GB | **$0.15/month** |
| Volume snapshots | First 10 GB free |
| TLS certificate (single hostname) | First 10 free |
| Shared IPv4 and IPv6 | Free (a dedicated IPv4 would be $2/month; not needed) |
| Outbound data, Europe | $0.02/GB |
| **Expected total** | **about $4/month**, plus a few cents of data |

Fly gives new accounts a $1 trial credit for 7 days. After that, a credit card is required.

## Production configuration

Non-secret settings are in `fly.toml` `[env]`, reviewed in Git. The production config:

| Setting | Value |
| --- | --- |
| `HCG_STORE_MODE` | `production` (refuses test payments, test ledgers, the development client, and downloads without launch approval) |
| `HCG_STORE_PUBLIC_ORIGIN` | `https://store.hakmicapitalgroup.com` (session cookie `__Host-…`, `Secure`, `HttpOnly`, `SameSite=Lax`) |
| `HCG_STORE_DATA_DIR` | `/data` (the volume) |
| Payments, downloads | `none`, `disabled` |
| Grant credential | not set (purchase grants off) |
| HCG Connect | phase 2 only: the commented block in `fly.toml`, with the **production** client ID |

The one secret is `HCG_STORE_SECRET_KEY`. It is 32 random bytes that seal the stored HCG tokens. It is
set with `fly secrets` and never written to a file, Git or a log. Losing or changing it signs everyone
out; nothing else is lost.

Logs never contain tokens, codes or cookies. The sign-in audit trail (`auth_events`) holds outcomes
only. `server-dist/auth-evidence.mjs` prints it without token values (`fly ssh console`).

## Steps

Commands run on your Mac, in `store/web-hcg-store` on `main` after the deployment PR is merged.
Nothing below is run by Claude.

### 0. Once: Fly account and tools

```bash
brew install flyctl
```

```bash
fly auth login
```

Add a payment method in the Fly dashboard. That is where the ~$4/month starts.

### 1. Create the app, volume and secret (no effect on the live site)

```bash
fly apps create hcg-store
```

```bash
fly volumes create hcg_store_data --app hcg-store --region arn --size 1
```

```bash
printf 'HCG_STORE_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" | fly secrets import --app hcg-store
```

### 2. Deploy the server without sign-in, and check it on its Fly address

```bash
fly deploy --build-arg GITHUB_SHA=$(git rev-parse HEAD)
```

```bash
node scripts/smoke-deployment.mjs https://hcg-store.fly.dev/ --expect-commit $(git rev-parse HEAD)
```

Expect `SMOKE OK`. `curl -s https://hcg-store.fly.dev/api/v1/health` shows `"mode":"production"`,
`"hcgConnect":"not-configured"`, payments and downloads disabled.

### 3. Prepare the certificate before moving DNS (no effect on the live site)

```bash
fly certs add store.hakmicapitalgroup.com --app hcg-store
```

It prints the DNS records Fly needs. At your DNS provider for `hakmicapitalgroup.com`, add **only the
`_acme-challenge.store` record** it shows. That lets Fly issue the certificate while GitHub Pages still
serves the site. Wait until this command reports the certificate as issued:

```bash
fly certs check store.hakmicapitalgroup.com --app hcg-store
```

### 4. Cut over DNS

1. At the DNS provider, **write down the current `store` record exactly** (type, value, TTL). That is
   the rollback value.
2. Change the `store` record to what `fly certs add` showed for the hostname: a CNAME to
   `hcg-store.fly.dev`, or the A and AAAA values from `fly ips list --app hcg-store`. Change no other record.
3. In GitHub, **Settings → Secrets and variables → Actions → Variables**, add `STORE_HOSTING` = `fly`.
   Pushes to `main` then stop publishing to Pages. Leave the Pages settings and the `CNAME` file as they
   are, for rollback.
4. Check (repeat until it passes; DNS caches take up to the old TTL):

```bash
node scripts/smoke-deployment.mjs https://store.hakmicapitalgroup.com/ --expect-commit $(git rev-parse HEAD)
```

The site looks and works the same as before. Sign-in still says it is not configured.

### 5. Production HCG Connect client

Once step 4 passes, send main HCG the request below. Then put the issued client ID into `fly.toml`:
uncomment the HCG Connect block and replace `<production client ID from HCG>`. Commit, merge and
deploy (step 2, or Actions → *Deploy Store server to Fly.io*). Then run:

```bash
npm run hcg:dev:verify -- --production
```

It runs the configuration checks against the production client and callback, the security checks
against the live server, and guides you through:
- sign-in;
- a restart (`fly apps restart hcg-store`);
- a refresh;
- logout.

It reads evidence through `fly ssh console`. Send the `.hcg-dev/evidence-production-*.md` report; ask HCG
to mark the client verified only if every row passes.

#### Request for main HCG (production client)

> Please issue a **dedicated production** HCG Connect client for HCG Store through the Owner workflow
> (ERP → App integrations → Inspect registrations → Issue or reuse login client). Do not reuse the
> development client `af487795-ead1-4671-8b09-76301762ee2c`.
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
> | Logout return URL | none |
> | Status | `configured_untested` until HCG Store sends the production evidence report |
>
> `https://store.hakmicapitalgroup.com` is now served by the HCG Store server (Fly.io, Stockholm);
> `GET https://store.hakmicapitalgroup.com/api/v1/health` returns its status. Send back the client ID only.

## Rollback

Try these in order; each is reversible.

| Problem | Action | Time |
| --- | --- | --- |
| Sign-in misbehaves | Comment the HCG Connect block in `fly.toml` out again and deploy. The site keeps working; sign-in shows "not configured". | ~3 min |
| A deploy breaks the server | `fly releases --app hcg-store --image` lists earlier images; `fly deploy --image <previous image>` restores one. | ~2 min |
| Fly itself is the problem | Set the `store` DNS record back to the value written down in step 4, delete the `STORE_HOSTING` variable, and re-run the Pages workflow (Actions → *Deploy storefront to GitHub Pages* → Run). | DNS TTL; GitHub may take time to re-issue its certificate, as it did on 15 Nov |

The database lives on the volume and survives every rollback above. Fly keeps daily volume
snapshots (`fly volumes snapshots list`).

## Status, kept separate

| Stage | Status |
| --- | --- |
| Code | Container, `fly.toml`, clean shutdown, evidence tool and production verifier are in the PR. The image was built and run in production mode in HCG Store's build environment: health, smoke, development-client refusal, production authorize URL, clean stop and data kept across a restart. |
| Deployed server | **Not deployed.** Needs steps 0–4 by the founder. |
| Verified production sign-in | **Not verified.** Needs step 5. |
