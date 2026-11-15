# Deployment guide

## 0. Production: https://store.hakmicapitalgroup.com/ on GitHub Pages

**What went wrong (15 November 2026).** The domain showed the repository README ("HCG Store (web
storefront)", npm commands) instead of the app. GitHub Pages was set to *Deploy from a branch*
(`main`, `/ (root)`), so GitHub's Jekyll builder rendered the repository root, and `README.md` became
`index.html`. The storefront in `web-hcg-store/` was never built or deployed. The repository had no
deployment workflow of its own.

**Fix.** `.github/workflows/deploy-pages.yml` builds the storefront and deploys **only**
`web-hcg-store/dist/`:

| Step | What it does |
|---|---|
| Build | `npm ci`, `npm test`, `npm run build` with `VITE_DEPLOY_ENV=production`, `VITE_PUBLIC_ORIGIN=https://store.hakmicapitalgroup.com`, `VITE_STORE_ACCOUNT_SERVICE=none`, `HCG_HOSTING_TARGET=github-pages` |
| Pages adaptations | Pages has no SPA rewrites and no custom headers. The build writes the app shell at every known route (`apps.html`, `apps/<slug>.html`, `apps/<slug>/releases.html`, …), so direct loads and reloads return 200. It also writes `404.html`, so unknown paths render the app's own "not found" page, and puts the CSP in a `<meta>` tag. |
| Verify | `scripts/verify-pages-artifact.mjs`: built app shell, every route page present, production manifest, and no source, server, markdown, env or binary files |
| Local smoke | `scripts/serve-pages-like.mjs` serves `dist/` with Pages' file rules, then `scripts/smoke-deployment.mjs` runs against it |
| Deploy | `actions/upload-pages-artifact` (`dist/` only) → `actions/deploy-pages` (pushes to `main` and manual runs) |
| Live smoke | `scripts/smoke-deployment.mjs https://store.hakmicapitalgroup.com/ --expect-commit <sha> --wait 600`. It fails if the README or any non-app page is served, a nested route, image or asset fails, the deployed commit differs, a source or protected path is reachable, the certificate is invalid, or http does not redirect to https. |

`hcg-build.json` at the site root records the deployed commit, environment and hosting target.

### Settings the repository owner must change (GitHub → F1r3srp3nt/store → Settings → Pages)

1. **Build and deployment → Source: "GitHub Actions"** (not "Deploy from a branch"). This alone stops
   the README from being published. Then re-run **Actions → Deploy storefront to GitHub Pages → Run
   workflow** on `main`, or push to `main`.
2. **Custom domain: `store.hakmicapitalgroup.com`.** Keep it. With Actions deployments the custom domain
   comes from this setting, not from the `CNAME` file. The root `CNAME` file stays harmlessly.
3. **Enforce HTTPS: on.** The option is greyed out until GitHub has issued the certificate for the
   domain, which can take up to about 24 hours after DNS points at Pages. If it stays unavailable,
   remove and re-add the custom domain to trigger issuance.
4. DNS for `store` (at the `hakmicapitalgroup.com` DNS provider): a `CNAME` record pointing to
   `f1r3srp3nt.github.io`, with no proxying CDN in front during certificate issuance. If the domain has
   CAA records, they must allow `letsencrypt.org`.

### What the static site can and cannot do

Public product browsing works. **Sign-in, the library, checkout and protected downloads do not run on
GitHub Pages**, because they need the HCG Store server (§2a). The static build is compiled with
`VITE_STORE_ACCOUNT_SERVICE=none`: it makes no account requests and says "Sign-in and purchases are
not available on this site". No file is downloadable. The HCG Connect redirect URI proposed to HCG,
`https://store.hakmicapitalgroup.com/auth/callback`, will only work once the domain is served by the
HCG Store server rather than Pages. Do not register it centrally before that.

Indexing stays off (`noindex`, `robots.txt` disallows) until the founder sets `VITE_ALLOW_INDEXING=true`
in the workflow.


No deployment, DNS, hosting or production configuration has been changed. Every step below is for the
founder to perform or approve.

## 1. Build

| Item | Value |
|---|---|
| Working directory | `web-hcg-store/` |
| Install | `npm ci` |
| Build command | `npm run build` (catalogue validation → type check → Vite build → secret scan) |
| Output directory | `web-hcg-store/dist/` |
| Node.js | 22.12 or later |
| Runtime | Static files for browsing. **Accounts, purchases and downloads need the HCG Store server** (§2a) |

`dist/` contains `index.html`, hashed `assets/`, `brand/`, `media/`, and generated files:

| File | Purpose |
|---|---|
| `robots.txt` | `Disallow: /` unless production indexing is explicitly enabled |
| `_headers` | Security headers (Netlify / Cloudflare Pages format) |
| `_redirects` | SPA fallback (`/* /index.html 200`) |
| `sitemap.xml` | Only for production builds with indexing and a public origin |
| `hcg-build.json` | Non-secret build info (environment, origin, indexing flag, build time) |

## 2. Hosting requirements

Any static host that can (a) serve `index.html` for unknown paths and (b) set response headers works.
No provider-specific runtime is used. The project has no dependency on Lovable's editor, runtime,
hosting or credits.

| Host | SPA fallback | Headers |
|---|---|---|
| Cloudflare Pages / Netlify | `dist/_redirects` (automatic) | `dist/_headers` (automatic) |
| Vercel | `vercel.json` rewrites | `vercel.json` headers (non-indexed defaults) |
| nginx | `try_files $uri $uri/ /index.html` | see `deploy/nginx.conf.example` (note the header-inheritance caveat) |
| Any other static host | rewrite all non-file paths to `/index.html` with status 200 | copy from `dist/_headers` |

Deep links (`/apps/hcg-mail`, `/apps/hcg-mail/releases`, `/account`) must return `index.html`. The e2e
suite checks this against `vite preview`.

Serving from a sub-path: build with `HCG_BASE_PATH=/store/ npm run build` and adjust the fallback.

## 2a. HCG Store server (accounts, checkout, protected delivery)

A static host serves the catalogue only. Its pages say sign-in is not available on that site. The
full Store runs the Node server, which serves `dist/` with the same security headers plus the account
API:

```bash
npm ci && npm run build      # builds dist/ and server-dist/main.mjs
npm run server:start         # node server-dist/main.mjs, reads the environment (.env.server.example)
```

- Node.js 22.12 or later. It uses the built-in `node:sqlite`, which prints an "experimental" warning
  on Node 22. State lives in `HCG_STORE_DATA_DIR` (one SQLite file): back it up, and keep it on
  persistent disk, not on an ephemeral container layer.
- Put it behind HTTPS (a reverse proxy or the platform's TLS) on the Store's public origin. Cookies are
  `__Host-` and `Secure` when the origin is https.
- **CDN:** cache only `/assets/*` (hashed and immutable). The server marks everything under `/api/`,
  `/auth/`, `/repo-api/` and `/test-checkout/` as `private, no-store` with `Vary: Cookie`. Do not
  override this with edge rules.
- Defaults are closed: no HCG Connect client means sign-in is "not configured", with no payments and
  downloads disabled. The server **refuses to start** with test payment providers or test entitlement
  ledgers in production, or with downloads enabled before launch approval (see [ACCESS.md](ACCESS.md)).
- Secrets: `HCG_STORE_SECRET_KEY` (and later any payment-provider or HCG grant credentials) go only in
  the host's secret store.

## 3. Environment variables

See `.env.example` for every variable with explanations. They are build-time values: rebuild after
changing them. Summary:

| Variable | Local | Preview | Production (future, founder-approved) |
|---|---|---|---|
| `VITE_DEPLOY_ENV` | `development` | `preview` | `production` |
| `VITE_PUBLIC_ORIGIN` | empty or `http://localhost:5173` | `https://<preview-host>` | `https://store.hakmicapitalgroup.com` |
| `VITE_ALLOW_INDEXING` | empty | empty (ignored anyway) | `true` only when going live |
| `VITE_CATALOGUE_PROVIDER` | `local` | `local` | `local` or `hcg-erp` once approved |
| `VITE_HCG_ERP_CATALOGUE_URL` | empty | approved beta endpoint | approved production endpoint |
| `VITE_HCG_REPO_BASE_URL` | empty (default) | empty | empty (`https://repo.hakmicapitalgroup.com/`) |

Safeguards enforced by the build:

- `store.hakmicapitalgroup.com` is rejected as `VITE_PUBLIC_ORIGIN` unless `VITE_DEPLOY_ENV=production`.
- Indexing is impossible outside production and requires an origin.
- Fixture data cannot be built for production.
- Credential-like `VITE_` variables fail the build. The output is scanned for secrets.

## 4. Security headers

Generated in `dist/_headers` (and served by `npm run preview`):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self' [+ configured ERP / HCG Connect origins]; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
X-Robots-Tag: noindex, nofollow                      (every non-production build)
Strict-Transport-Security: max-age=31536000          (production builds only)
```

Fonts are self-hosted, with no third-party requests. Downloads are same-origin server responses, so
they are not affected by `connect-src`.

## 5. Preview deployment (safe first step)

1. Create a project on the chosen static host pointing at `web-hcg-store/`, using the build command and
   output above.
2. Set `VITE_DEPLOY_ENV=preview` and, optionally, `VITE_PUBLIC_ORIGIN=https://<preview-host>`.
3. Deploy and check `/`, `/apps/hcg-mail`, `/apps/hcg-mail/releases`, `/account`, a random 404 path,
   `/robots.txt` (must disallow) and response headers (must include `X-Robots-Tag: noindex`).

## 6. Future DNS and HTTPS steps (do not perform until approved)

1. Decide the production host and plan.
2. Add the custom domain `store.hakmicapitalgroup.com` in the host's dashboard. It will show the required
   record, usually a `CNAME store → <host target>`.
3. In the DNS provider for `hakmicapitalgroup.com`, add that record. Do not change other records.
4. Wait for the host to issue the TLS certificate. Verify `https://store.hakmicapitalgroup.com` loads with
   a valid certificate and HTTP redirects to HTTPS.
5. Rebuild with `VITE_DEPLOY_ENV=production`, `VITE_PUBLIC_ORIGIN=https://store.hakmicapitalgroup.com`
   and, only if the founder approves search indexing, `VITE_ALLOW_INDEXING=true`.
6. For Vercel or nginx, remove the static `X-Robots-Tag` header only for the approved production site.
7. Enable HSTS only after HTTPS is confirmed stable. Consider preload separately.

## 7. Auth callback changes requiring review

HCG Store's server uses the redirect URI `<origin>/auth/callback`. Central HCG must allow-list it for
each environment separately: `http://localhost:8787/auth/callback`, the preview host and, only once
live, `https://store.hakmicapitalgroup.com/auth/callback`. Never register the production callback before
the domain serves this project. See [HCG-INTEGRATION.md](HCG-INTEGRATION.md) §4.

## 8. Rollback

The site is static, so rollback means serving the previous build:

- Cloudflare Pages / Netlify / Vercel: promote or "rollback to" the previous deployment in the dashboard.
- nginx / object storage: keep each build in a versioned folder (e.g. `releases/<git-sha>/`) and switch
  the `root` symlink back, then reload nginx.
- From Git: `git revert <commit>` on the deployment branch and redeploy.
- Catalogue-only problems (e.g. a bad release link): revert the `catalogue/releases.json` change or set
  the product's `currentReleaseId` back, then rebuild. To pull a file immediately, disable the Dropbox
  shared link, because public links keep working even after the store stops showing them.
- DNS: re-point the `store` record to its previous target. DNS caches can take up to the record's TTL
  to expire.
