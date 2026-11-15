# HCG Store — notes for Claude Code

The web storefront is in `web-hcg-store/` (React + TypeScript + Vite, plain CSS tokens, zod, Vitest, Playwright).
The HCG Store server (sign-in, sessions, entitlements, checkout, protected delivery) is in `web-hcg-store/server/` (Node 22, node:sqlite, jose).

## Commands (run inside web-hcg-store/)
- `npm ci` · `npm run dev` · `npm run check` (validate catalogue + typecheck + unit tests + build)
- `npm run build && npm run build:fixture && npm run test:e2e` for end-to-end tests
- `npm run validate:catalogue` after any change to `catalogue/*.json`
- `npm run check:repo-mapping -- <HCG-repo checkout>` after changing editions or HCG Repo links

## Rules
- Never invent releases, download links, prices, ratings, reviews, download counts, screenshots or account state.
- Development status and release availability stay separate. `currentReleaseId` is explicit; never infer "latest".
- Catalogue data is provisional; HCG ERP is the source of truth. Catalogue files are public: no private repo names or internal URLs.
- No secrets in `VITE_` variables or frontend code. Do not simulate HCG Connect sign-in.
- Do not deploy, change DNS, register OAuth clients, merge, or alter central HCG policy. Propose changes in docs for founder review.
- Downloads stay disabled and live payments stay off until the launch conditions in docs/ACCESS.md are met and the founder approves. Never put download URLs in the public catalogue; never let a redirect, button or client flag grant access.
- Keep non-production builds noindex; the future domain store.hakmicapitalgroup.com is not live.
