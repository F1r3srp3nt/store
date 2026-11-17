# HCG Connect: local development sign-in

How to run HCG Store's server on your own computer against the **real** HCG Connect, with the
development client, and produce evidence that sign-in works. Purchases and protected downloads stay
disabled throughout.

## The development client

| Field | Value |
| --- | --- |
| Client ID | `af487795-ead1-4671-8b09-76301762ee2c` (public, not a secret) |
| Product, integration key | `hcg.store`, `hcg-store-web-development` |
| Type | Public client, token endpoint auth `none`, no secret |
| Grants, PKCE, scopes | `authorization_code` + `refresh_token`, S256, `openid email profile` |
| Callback (exact) | `http://127.0.0.1:8787/auth/callback` |
| HCG status | `configured_untested`. Ask HCG to mark it verified only after the sign-in checks below pass. |

The configuration is in `server/dev/hcg-connect.development.env`. It is development-only: the server
refuses this client ID in production mode, and production needs its own client for the production
callback (see [PRODUCTION-DEPLOY.md](PRODUCTION-DEPLOY.md)).

## On your Mac

You need Node.js 22.5 or later (`node --version`) and git. The browser must run on the same Mac,
because the callback is `127.0.0.1`.

```bash
git clone https://github.com/F1r3srp3nt/store.git
```

```bash
cd store/web-hcg-store
```

```bash
npm ci
```

```bash
npm run build
```

```bash
npm run hcg:dev
```

Leave that running. It creates `.hcg-dev/` (git-ignored) with a local session key and database, and
serves the Store at <http://127.0.0.1:8787>.

In a second terminal, in the same folder:

```bash
npm run hcg:dev:verify
```

It first runs the automatic checks, then asks you to:

1. open <http://127.0.0.1:8787/account>, choose **Sign in with HCG Connect** and sign in with your HCG account;
2. restart the server (Ctrl-C, then `npm run hcg:dev` again) and reload the Account page;
3. wait 30 seconds and reload the Account page again (token refresh);
4. choose **Sign out**.

Type `skip` at any step you cannot do; it is reported as "not run", never as passed. The report is
written to `.hcg-dev/evidence-<time>.md`. It contains no tokens, codes or cookies, only results, times,
reasons and the first 8 characters of your account ID. Send that file back for the handoff.

`npm run hcg:dev:verify -- --auto-only` runs only the automatic checks.

## What each check proves

| # | Check | Evidence |
| --- | --- | --- |
| 1 | Authorization starts with PKCE and state | The Store's `/auth/login` redirect to HCG's authorize endpoint: S256 challenge, ≥32-character state and a nonce, fresh per attempt, exact callback |
| 2 | Sign-in returns to the exact callback | `login_succeeded` event recorded for `http://127.0.0.1:8787/auth/callback` |
| 3 | Code exchange; account matches `/me` | ID token (issuer, audience = client ID, nonce) and access token (issuer, client) verified with HCG's keys; `/me` returns the same account ID, otherwise the sign-in is refused |
| 4 | Session restored; token refresh | The same session used after a server restart; `session_refreshed` with the refresh token rotated |
| 5 | Logout | Session ended, both stored tokens deleted. HCG Connect itself is **not** signed out: it advertises no end-session or revocation endpoint |
| 6 | Invalid and replayed callbacks; unauthenticated requests | Forged state, missing state and a reused state are refused; an invalid code is refused by HCG's token endpoint; `/api/v1/library` without a session answers 401 |

Where the evidence comes from: HCG's public endpoints, the local server's HTTP answers, and the
server's `auth_events` table and token-free session columns. Tokens stay sealed in the server's
database; the browser holds only an HttpOnly cookie. Nothing logs a token.

## Behind a proxy

Node's built-in `fetch` ignores `HTTPS_PROXY`. On a network that needs a proxy, start both commands
with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later). A normal home or office connection does not need it.
