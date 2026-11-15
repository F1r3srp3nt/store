import type { Page } from "@playwright/test";

export const REAL = "http://localhost:4173";
export const FIXTURE = "http://localhost:4174";
/** TEST-mode HCG Store server with the mock HCG Connect provider (server/test/e2e-server.ts). */
export const ACCOUNT = "http://127.0.0.1:4175";

export const ROUTES = [
  { path: "/", h1: /HCG\s*Store/ },
  { path: "/apps", h1: /Browse apps/ },
  { path: "/apps/hcg-mail", h1: /HCG Mail/ },
  { path: "/apps/hcg-executable-maker", h1: /HCG Executable Maker/ },
  { path: "/apps/hcg-lifeos/releases", h1: /HCG LifeOS/ },
  { path: "/apps/hcg-terminal?edition=unleashed", h1: /HCG Terminal/ },
  { path: "/library", h1: /Your library/ },
  { path: "/checkout/return?checkout=chk_forged", h1: /Checkout not found/ },
  { path: "/getting-started", h1: /Getting started/ },
  { path: "/account", h1: /Account & Connections/ },
  { path: "/apps?platform=macos&category=developer-tools", h1: /Browse apps/ },
  { path: "/definitely/not/a/page", h1: /Page not found/ },
];

/**
 * Collects console errors and page errors, including CSP violations reported by Chromium.
 *
 * The static preview servers (4173/4174) have no HCG Store account service, so the app's
 * /api/v1/* requests get 404 there by design (the UI then says sign-in is not available on this
 * site). Those expected 404s are ignored; any other failed resource is reported with its URL.
 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/^Failed to load resource: the server responded with a status of 40[134]/.test(m.text())) return; // reported below with the URL
    errors.push(m.text());
  });
  page.on("response", (r) => {
    const u = new URL(r.url());
    const expectedOnStaticHost = u.pathname.startsWith("/api/v1/") && (u.port === "4173" || u.port === "4174") && r.status() === 404;
    const expectedDenial = u.pathname.startsWith("/api/v1/") && (r.status() === 401 || r.status() === 403);
    if (r.status() >= 400 && !expectedOnStaticHost && !expectedDenial) errors.push(`${r.status()} ${u.pathname}`);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

export const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
