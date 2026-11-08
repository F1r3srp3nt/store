import type { Page } from "@playwright/test";

export const REAL = "http://localhost:4173";
export const FIXTURE = "http://localhost:4174";

export const ROUTES = [
  { path: "/", h1: /HCG\s*Store/ },
  { path: "/apps", h1: /Browse apps/ },
  { path: "/apps/hcg-mail", h1: /HCG Mail/ },
  { path: "/apps/hcg-executable-maker", h1: /HCG Executable Maker/ },
  { path: "/apps/hcg-analytics-and-measure/releases", h1: /HCG Analytics & Measure/ },
  { path: "/getting-started", h1: /Getting started/ },
  { path: "/account", h1: /Account & Connections/ },
  { path: "/apps?platform=macos&category=developer-tools", h1: /Browse apps/ },
  { path: "/definitely/not/a/page", h1: /Page not found/ },
];

/** Collects console errors and page errors, including CSP violations reported by Chromium. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

export const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
