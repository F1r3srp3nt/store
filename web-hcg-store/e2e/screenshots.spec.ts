import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";
import { ACCOUNT, FIXTURE, REAL } from "./helpers";

/** Captures documentation screenshots. Run with `npm run screenshots`. */
const OUT = resolve(import.meta.dirname, "../docs/screenshots");
test.skip(!process.env.HCG_CAPTURE_SCREENSHOTS, "Set HCG_CAPTURE_SCREENSHOTS=1 (npm run screenshots).");

const shots: { name: string; url: string; width: number; height: number; full?: boolean }[] = [
  { name: "home-1440", url: REAL + "/", width: 1440, height: 900, full: true },
  { name: "browse-1440", url: REAL + "/apps", width: 1440, height: 1000 },
  { name: "product-executable-maker-1440", url: REAL + "/apps/hcg-executable-maker", width: 1440, height: 1100 },
  { name: "product-terminal-editions-1440", url: REAL + "/apps/hcg-terminal?edition=unleashed", width: 1440, height: 1400 },
  { name: "account-1440", url: REAL + "/account", width: 1440, height: 1000 },
  { name: "getting-started-1024", url: REAL + "/getting-started", width: 1024, height: 1000 },
  { name: "home-390", url: REAL + "/", width: 390, height: 844 },
  { name: "product-mail-390", url: REAL + "/apps/hcg-mail", width: 390, height: 844 },
  { name: "browse-768", url: REAL + "/apps?platform=macos", width: 768, height: 1024 },
  { name: "fixture-release-panel-1440", url: FIXTURE + "/apps/fixture-orbit-notes", width: 1440, height: 1500 },
  { name: "fixture-release-history-390", url: FIXTURE + "/apps/fixture-orbit-notes/releases", width: 390, height: 844, full: true },
];

test("capture documentation screenshots", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(s.url, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      // load lazy images before capturing
      document.querySelectorAll("img[loading=lazy]").forEach((i) => ((i as HTMLImageElement).loading = "eager"));
      await new Promise((r) => setTimeout(r, 300));
    });
    await page.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: Boolean(s.full) });
    await ctx.close();
  }
});

/** TEST-mode account flow (mock HCG Connect, TEST payments): signed-in, test checkout, owned. */
test("capture TEST-mode account screenshots", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.request.post(`http://127.0.0.1:4176/__test/next-user/${encodeURIComponent(`screenshot-${Date.now()}`)}`);
  await page.goto(`${ACCOUNT}/auth/login?return_to=${encodeURIComponent("/apps/fixture-quasar-shell?edition=unleashed")}`);
  await page.locator("#edition-unleashed").getByRole("button", { name: "Buy Product" }).waitFor();
  await page.screenshot({ path: `${OUT}/test-mode-not-owned-1440.png` });
  await page.locator("#edition-unleashed").getByRole("button", { name: "Buy Product" }).click();
  await page.getByRole("button", { name: "Simulate successful payment" }).waitFor();
  await page.screenshot({ path: `${OUT}/test-mode-checkout-1440.png` });
  await page.getByRole("button", { name: "Simulate successful payment" }).click();
  await page.getByRole("heading", { name: "Purchase confirmed" }).waitFor();
  await page.goto(`${ACCOUNT}/apps/fixture-quasar-shell?edition=unleashed`);
  await page.locator("#edition-unleashed").getByText("Owned", { exact: true }).waitFor();
  await page.screenshot({ path: `${OUT}/test-mode-owned-1440.png` });
  await page.goto(`${ACCOUNT}/library`);
  await page.getByRole("heading", { name: "Purchase history" }).waitFor();
  await page.screenshot({ path: `${OUT}/test-mode-library-1440.png` });
  await ctx.close();
});
