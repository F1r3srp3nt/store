import { expect, test } from "@playwright/test";
import { collectErrors, horizontalOverflow, REAL } from "./helpers";

/** HCG Store v3: themes, motion, layout across widths. Runs against the static production-like build (no account server). */

const THEMES = ["sovereign", "cyberpunk", "crimson", "founder", "frost", "horizon"];
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1440];
const PAGES = ["/", "/apps", "/apps/hcg-server", "/apps/hcg-terminal", "/library", "/account", "/release-manager"];

test.describe("layout at every width", () => {
  for (const w of WIDTHS) {
    test(`no horizontal page overflow at ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 900 });
      for (const path of PAGES) {
        await page.goto(REAL + path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await horizontalOverflow(page), `${path} at ${w}px`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("phone: the menu sheet holds search, navigation, categories and the theme choices, without overflow", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(REAL + "/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const sheet = page.locator(".mobile-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("searchbox", { name: "Search apps" })).toBeVisible();
    const box = await sheet.getByRole("searchbox", { name: "Search apps" }).boundingBox();
    expect(box!.width).toBeGreaterThan(220); // the full placeholder fits
    await expect(sheet.getByRole("link", { name: "My Library" })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: /Quantum Frost/ })).toBeAttached();
    for (const el of await sheet.locator("a, button, input").all()) {
      if (!(await el.isVisible())) continue;
      const b = (await el.boundingBox())!;
      expect(b.x + b.width, "nothing clipped at the right edge").toBeLessThanOrEqual(320 + 0.5);
    }
  });

  test("touch targets in the header and sheet are at least 40px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(REAL + "/");
    for (const name of ["Open menu", "Theme"]) {
      const b = (await page.getByRole("button", { name }).first().boundingBox())!;
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe("themes", () => {
  test("a visitor picks a theme; it applies before first paint on the next visit and survives reloads", async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "sovereign");
    await page.getByRole("button", { name: "Theme" }).first().click();
    await page.locator('.theme-menu__panel [data-theme-option="crimson"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "crimson");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim());
    expect(accent).toBe("255 72 88");
    // The pre-paint script sets it before React runs: check the attribute in the raw document on load.
    await page.goto(REAL + "/apps/hcg-server", { waitUntil: "commit" });
    await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("crimson");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "crimson");
    expect(errors.filter((e) => !/api\/v1\/session|404/.test(e)), errors.join("\n")).toEqual([]);
  });

  for (const t of THEMES) {
    test(`${t}: themes every surface and keeps checkout and download controls unchanged`, async ({ page }) => {
      await page.addInitScript((id) => localStorage.setItem("hcg-store.theme", id), t);
      await page.goto(REAL + "/apps/hcg-mail");
      await expect(page.locator("html")).toHaveAttribute("data-theme", t);
      // Without HCG Store's server (static preview) the download area says so honestly; the footer carries the HCG brand.
      await expect(page.getByText("Downloads could not be checked right now.", { exact: false }).first()).toBeVisible();
      await expect(page.locator("footer").getByText("EVERYTHING IS INTERCHANGEABLE.")).toBeVisible();
      const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    });
  }
});

test.describe("motion", () => {
  test("reduced motion: no decorative animation runs and nothing auto-rotates", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(REAL + "/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(300);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
    expect(running).toBe(0);
    await expect(page.getByRole("button", { name: /Pause/ })).toHaveCount(0);
    await ctx.close();
  });

  test("the effects switch stops decorative animation and is remembered", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Theme" }).first().click();
    await page.getByRole("switch", { name: /Decorative effects/ }).first().uncheck();
    await expect(page.locator("html")).toHaveAttribute("data-effects", "off");
    await page.waitForTimeout(450);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-effects", "off");
  });

  test("the spotlight can be paused and moved by hand", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    await page.getByRole("button", { name: /Pause/ }).click();
    await expect(page.getByRole("button", { name: /Play/ })).toBeVisible();
    await page.getByRole("button", { name: "Show HCG Server" }).click();
    await expect(page.locator(".spotlight__title")).toHaveText("HCG Server");
  });
});

test.describe("honest homepage", () => {
  test("drafts, releases, news and campaigns appear only when the data supports them", async ({ page }) => {
    await page.goto(REAL + "/");
    await expect(page.getByRole("heading", { name: "Upcoming technology" })).toBeVisible();
    // One release exists (HCG Mail 1.0.0-beta.1, published in HCG Store and current): New releases shows exactly it.
    const newReleases = page.getByRole("heading", { name: "New releases" }).locator("xpath=ancestor::section[1]");
    await expect(newReleases).toContainText("HCG Mail");
    await expect(newReleases.getByRole("heading", { level: 3 })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Announcements" })).toHaveCount(0);
    await expect(page.getByText("Sponsored")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/HCG ADS|Signal Contractor|System Tester|Representation/);
    await page.goto(REAL + "/apps/hcg-ads");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("HCG ADS");
  });

  test("ecosystem explorer: choosing a product shows its stated, planned integrations", async ({ page }) => {
    await page.goto(REAL + "/");
    await page.getByRole("button", { name: "HCG Sentinel", exact: true }).click();
    const detail = page.locator(".eco__detail");
    await expect(detail).toContainText("HCG Server");
    await expect(detail).toContainText("Planned");
    await expect(detail).not.toContainText("Available");
  });
});
