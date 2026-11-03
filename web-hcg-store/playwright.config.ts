import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against PRODUCTION builds served by `vite preview`, which applies the same
 * security headers (including CSP) as the generated `_headers` file.
 *   - port 4173: the real catalogue (dist/)
 *   - port 4174: the clearly-labelled test fixture catalogue (dist-fixture/)
 * Build both first: `npm run build && npm run build:fixture` (done by `npm run test:e2e:full`).
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: [["list"]],
  timeout: 30_000,
  use: { trace: "off", deviceScaleFactor: 1 },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: false, timeout: 60_000 },
    {
      command: "npx vite preview --outDir dist-fixture --port 4174 --strictPort",
      url: "http://localhost:4174",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
