# HCG Store — notes for Claude Code

The web storefront is in `web-hcg-store/` (React + TypeScript + Vite, plain CSS tokens, zod, Vitest, Playwright).

## Commands (run inside web-hcg-store/)
- `npm ci` · `npm run dev` · `npm run check` (validate catalogue + typecheck + unit tests + build)
- `npm run build && npm run build:fixture && npm run test:e2e` for end-to-end tests
- `npm run validate:catalogue` after any change to `catalogue/*.json`

## Rules
- Never invent releases, download links, prices, ratings, reviews, download counts, screenshots or account state.
- Development status and release availability stay separate. `currentReleaseId` is explicit; never infer "latest".
- Catalogue data is provisional; HCG ERP is the source of truth. Catalogue files are public: no private repo names or internal URLs.
- No secrets in `VITE_` variables or frontend code. Do not simulate HCG Connect sign-in.
- Do not deploy, change DNS, register OAuth clients, merge, or alter central HCG policy. Propose changes in docs for founder review.
- Keep non-production builds noindex; the future domain store.hakmicapitalgroup.com is not live.
