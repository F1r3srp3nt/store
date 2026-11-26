import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against PRODUCTION builds served by `vite preview`, which applies the same
 * security headers (including CSP) as the generated `_headers` file.
 *   - port 4173: the real catalogue (dist/)
 *   - port 4174: the clearly-labelled test fixture catalogue (dist-fixture/)
 *   - port 4175: the HCG Store server in TEST mode serving dist-fixture/, with a mock HCG Connect
 *     provider on 4176, TEST offers and private TEST files (server/test/e2e-server.ts)
 *   - port 4177: the same server with publishing enabled for the Control Center (server/test/admin-e2e-server.ts)
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
    { command: "npx tsx server/test/e2e-server.ts", url: "http://127.0.0.1:4175/api/v1/health", reuseExistingServer: false, timeout: 60_000 },
    // HCG Store Control Center: publishing enabled, mock HCG Connect on 4178 (server/test/admin-e2e-server.ts).
    { command: "npx tsx server/test/admin-e2e-server.ts", url: "http://127.0.0.1:4177/api/v1/health", reuseExistingServer: false, timeout: 60_000 },
  ],
});
