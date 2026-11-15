# Deployment guide (prepared, NOT applied)

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
