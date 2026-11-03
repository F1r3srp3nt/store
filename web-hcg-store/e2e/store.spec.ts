import { expect, test } from "@playwright/test";
import { collectErrors, FIXTURE, horizontalOverflow, REAL, ROUTES } from "./helpers";

test.describe("routes and direct navigation", () => {
  for (const r of ROUTES) {
    test(`direct load ${r.path}`, async ({ page }) => {
      const errors = collectErrors(page);
      const res = await page.goto(REAL + r.path);
      expect(res?.status()).toBe(200); // SPA fallback serves index.html for deep links
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(r.h1);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("client-side navigation moves focus to main content", async ({ page }) => {
    await page.goto(REAL + "/");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Browse apps" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Browse apps");
    await expect(page.locator("#main")).toBeFocused();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/HCG\s*Store/);
  });
});

test.describe("indexing safety for non-production builds", () => {
  test("noindex everywhere, no canonical, robots disallows", async ({ page, request }) => {
    const res = await page.goto(REAL + "/apps/hcg-mail");
    expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    const html = await (await request.get(REAL + "/")).text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"');
    expect(html).not.toContain("store.hakmicapitalgroup.com");
    expect(await (await request.get(REAL + "/robots.txt")).text()).toContain("Disallow: /");
    expect((await request.get(REAL + "/sitemap.xml")).headers()["content-type"]).not.toContain("xml");
  });

  test("security headers are served", async ({ request }) => {
    const h = (await request.get(REAL + "/")).headers();
    expect(h["content-security-policy"]).toContain("default-src 'self'");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });
});

test.describe("responsive layouts", () => {
  // 320 and 507 approximate narrow tablet multitasking (Split View / Slide Over) widths.
  const widths = [320, 390, 507, 768, 1024, 1440];
  const pages = ["/", "/apps", "/apps/hcg-executable-maker", "/apps/hcg-mail/releases", "/getting-started", "/account"];
  for (const width of widths) {
    test(`no horizontal overflow at ${width}px`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      for (const p of pages) {
        await page.goto(REAL + p);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await horizontalOverflow(page), `${p} at ${width}px`).toBeLessThanOrEqual(0);
      }
      await ctx.close();
    });
  }

  test("fixture release pages do not overflow on phones", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    for (const p of ["/apps/fixture-orbit-notes", "/apps/fixture-orbit-notes/releases"]) {
      await page.goto(FIXTURE + p);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await horizontalOverflow(page), p).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  });

  test("below-the-fold screenshots are lazy-loaded", async ({ page }) => {
    await page.goto(REAL + "/apps/hcg-executable-maker");
    const imgs = page.locator(".gallery img");
    await expect(imgs).toHaveCount(2);
    for (const i of [0, 1]) await expect(imgs.nth(i)).toHaveAttribute("loading", "lazy");
  });
});

test.describe("keyboard navigation", () => {
  test("skip link, primary navigation and product cards are keyboard operable", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    // Reach a product card link by keyboard and open it.
    const card = page.getByRole("link", { name: "HCG Mail" }).first();
    for (let i = 0; i < 40 && !(await card.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(card).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("HCG Mail");
  });

  test("mobile menu opens and closes with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(REAL + "/");
    const toggle = page.getByRole("button", { name: "Open menu" });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    const mobileNav = page.getByRole("navigation", { name: "Primary (mobile)" });
    await expect(mobileNav.getByRole("link", { name: "Getting started" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(mobileNav).toBeHidden();
  });

  test("filters work from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/apps");
    await page.getByRole("searchbox", { name: "Search", exact: true }).focus();
    await page.keyboard.type("imap");
    await expect(page.getByRole("status").filter({ hasText: "products" })).toHaveText("1 of 14 products match");
    await expect(page).toHaveURL(/\?q=imap/);
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
    await page.getByRole("checkbox", { name: "iOS" }).focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/platform=ios/);
    await expect(page.getByRole("link", { name: "HCG CardX" })).toBeVisible();
  });

  test("header search submits to the browse page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    await page.getByRole("searchbox", { name: "Search apps" }).first().fill("terminal");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps\?q=terminal/);
    await expect(page.getByRole("link", { name: "HCG Terminal" })).toBeVisible();
  });
});

test.describe("reduced motion", () => {
  test("orbital animation runs normally and stops with prefers-reduced-motion", async ({ browser }) => {
    const anim = async (reducedMotion: "reduce" | "no-preference") => {
      const ctx = await browser.newContext({ reducedMotion });
      const page = await ctx.newPage();
      await page.goto(REAL + "/");
      const name = await page.locator(".orbital__spin").evaluate((el) => getComputedStyle(el).animationName);
      const transition = await page.locator(".product-card").first().evaluate((el) => getComputedStyle(el).transitionDuration);
      await ctx.close();
      return { name, transition };
    };
    expect((await anim("no-preference")).name).toBe("orbit");
    const reduced = await anim("reduce");
    expect(reduced.name).toBe("none");
    expect(reduced.transition.split(",").every((d) => parseFloat(d) < 0.01)).toBe(true);
  });

  test("text stays visible when images are blocked", async ({ page }) => {
    await page.route(/\.(webp|png)$/, (r) => r.abort());
    await page.goto(REAL + "/apps/hcg-executable-maker");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("HCG Executable Maker");
    await expect(page.getByText("Image unavailable").first()).toBeVisible();
  });
});

test.describe("honesty checks on the shipped catalogue", () => {
  test("no fabricated availability, account state or statistics on any page", async ({ page }) => {
    for (const r of ROUTES) {
      await page.goto(REAL + r.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // The Getting started page states that ratings and reviews are NOT shown; that disclaimer is allowed.
      const text = (await page.locator("body").innerText()).replace("Download counts, ratings and reviews are not shown", "");
      expect(text).not.toMatch(/\b\d[\d,.]*\s*(downloads|installs|users)\b/i);
      expect(text).not.toMatch(/\bratings?\b|\breviews?\b|★|\$\s?\d|€\s?\d|add to cart|\bbuy\b|signed in as|successfully installed/i);
      expect(await page.locator("a[href*='dropbox']").count()).toBe(0);
    }
  });
});
