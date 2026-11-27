import { expect, test, type Page } from "@playwright/test";
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
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Products", exact: true }).click();
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

  test("product banner is the priority image; screenshots below it are lazy-loaded", async ({ page }) => {
    await page.goto(REAL + "/apps/hcg-executable-maker");
    const banner = page.locator(".product-banner img");
    await expect(banner).toHaveAttribute("loading", "eager");
    await expect(banner).toHaveAttribute("fetchpriority", "high");
    // Chromium supports AVIF, so it picks the AVIF rendition; the WebP files stay as the fallback.
    await expect.poll(() => banner.evaluate((i: HTMLImageElement) => i.currentSrc)).toMatch(/banner-\d+\.avif$/);
    // Genuine screenshots, grouped by the platform each capture ran on: macOS first (1), then Linux (3).
    const shots = page.locator(".product-gallery img");
    await expect(shots).toHaveCount(1);
    await page.getByRole("group", { name: "Screenshots by platform" }).getByRole("button", { name: /Linux/ }).click();
    await expect(shots).toHaveCount(3);
    for (const s of await shots.all()) await expect(s).toHaveAttribute("loading", "lazy");
  });

  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`banners and icons are shown whole at ${width}px: no cropping or distortion`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      for (const path of ["/", "/apps", "/apps/hcg-lifeos", "/apps/hcg-one-unleashed"]) {
        await page.goto(REAL + path);
        // Scroll through the page like a visitor so lazy-loaded artwork loads.
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 500) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 40));
          }
          // Swipe through horizontal shelves too: cards beyond the visible part load when they come into view.
          for (const track of Array.from(document.querySelectorAll<HTMLElement>(".shelf__track, .featured"))) {
            track.scrollIntoView({ block: "center" });
            for (let x = 0; x <= track.scrollWidth; x += track.clientWidth / 2) {
              track.scrollLeft = x;
              await new Promise((r) => setTimeout(r, 40));
            }
          }
        });
        // Wait until every artwork image has actually decoded (a broken one would never get there).
        await expect
          .poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>(".product-cover--art img, .product-banner img, .product-mark--icon img")).every((i) => i.naturalWidth > 0)), {
            message: `${path} at ${width}px: artwork loaded`,
          })
          .toBe(true);
        const bad = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLImageElement>(".product-cover--art img, .product-banner img, .product-mark--icon img"))
            .filter((img) => img.getClientRects().length > 0) // decoration hidden at this width is not measured
            .map((img) => {
              const fit = getComputedStyle(img).objectFit;
              const box = img.clientWidth / img.clientHeight;
              const natural = img.naturalWidth / img.naturalHeight;
              // "contain" never crops or stretches; any other fit is fine only if the box has the image's own ratio.
              const ok = img.naturalWidth > 0 && (fit === "contain" || Math.abs(box - natural) < 0.03);
              return ok ? null : `${img.currentSrc} box ${box.toFixed(2)} natural ${natural.toFixed(2)} fit ${fit}`;
            })
            .filter(Boolean),
        );
        expect(bad, `${path} at ${width}px`).toEqual([]);
      }
      await ctx.close();
    });
  }

  test("listing cards lazy-load their art", async ({ page }) => {
    await page.goto(REAL + "/apps");
    const imgs = page.locator(".product-card img");
    expect(await imgs.count()).toBeGreaterThan(0);
    for (const img of await imgs.all()) await expect(img).toHaveAttribute("loading", "lazy");
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
    await expect(page.getByRole("status").filter({ hasText: "products" })).toHaveText("1 of 11 products match");
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
    // Don't rely on the URL alone: with React Router's default transitions the URL changed before
    // the browse page rendered, and the home page (which links "HCG Terminal" twice) was still on
    // screen. The app now renders route changes urgently (App.tsx); this test still waits for the
    // browse page itself and looks for the result only in its results region.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Browse apps");
    const results = page.getByRole("region", { name: "Results" });
    await expect(results.getByRole("status")).toHaveText("1 of 11 products match");
    await expect(results.getByRole("link", { name: "HCG Terminal", exact: true })).toBeVisible();
  });
});

test.describe("navigation on a busy device", () => {
  // Chromium CPU throttling makes renders slow enough to expose URL/render races deterministically.
  const throttle = async (page: Page, rate: number) => (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });

  test("a filter ticked right after clearing the search keeps the search cleared", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/apps?q=imap");
    await expect(page.getByRole("status").filter({ hasText: "products" })).toHaveText("1 of 11 products match");
    await throttle(page, 20);
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
    await page.getByRole("checkbox", { name: "iOS" }).focus();
    await page.keyboard.press("Space");
    await expect.poll(() => new URL(page.url()).search).toBe("?platform=ios");
    await expect(page.getByRole("region", { name: "Results" }).getByRole("link", { name: "HCG CardX" })).toBeVisible();
  });

  test("the browse page is on screen once the URL shows the search", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(REAL + "/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await throttle(page, 20);
    await page.getByRole("searchbox", { name: "Search apps" }).first().fill("terminal");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps\?q=terminal/);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Browse apps");
  });
});

test.describe("reduced motion", () => {
  test("motion is reduced with prefers-reduced-motion", async ({ browser }) => {
    const motion = async (reducedMotion: "reduce" | "no-preference") => {
      const ctx = await browser.newContext({ reducedMotion });
      const page = await ctx.newPage();
      await page.goto(REAL + "/");
      await expect(page.locator(".product-card").first()).toBeVisible();
      const transition = await page.locator(".product-card").first().evaluate((el) => getComputedStyle(el).transitionDuration);
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      await ctx.close();
      return { transition, running };
    };
    const normal = await motion("no-preference");
    expect(normal.transition.split(",").some((d) => parseFloat(d) > 0.05)).toBe(true);
    const reduced = await motion("reduce");
    expect(reduced.transition.split(",").every((d) => parseFloat(d) < 0.01)).toBe(true);
    expect(reduced.running).toBe(0);
  });

  test("home hero shows the full banner, uncropped, labelled as an illustration, loaded eagerly", async ({ page }) => {
    await page.goto(REAL + "/");
    const banner = page.locator(".hero-banner img");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("loading", "eager");
    await expect(banner).toHaveAttribute("alt", /HCG STORE wordmark/);
    await expect(banner).toHaveAttribute("srcset", /hcg-store-hero-2172\.webp 2172w/);
    // The whole 3:1 artwork is shown: the rendered box keeps the image's aspect ratio (no crop).
    const box = await banner.evaluate((img: HTMLImageElement) => ({ w: img.clientWidth, h: img.clientHeight, fit: getComputedStyle(img).objectFit }));
    expect(Math.abs(box.w / box.h - 2172 / 724)).toBeLessThan(0.03);
    expect(["contain", "fill"]).toContain(box.fit);
    await expect(page.locator(".hero-banner").getByText("Illustration")).toBeVisible();
    expect(await banner.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  });

  test("home hero text remains when the banner cannot load", async ({ page }) => {
    await page.route(/hcg-store-(hero|wordmark)-[\w-]+\.(avif|webp)$/, (r) => r.abort());
    await page.goto(REAL + "/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/HCG\s*Store/);
    await expect(page.locator(".hero-banner")).toHaveCount(0);
    await expect(page.locator(".hero3__wordmark")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 }).getByText("HCG Store")).toBeVisible();
    await expect(page.getByRole("link", { name: /Browse Products/ }).first()).toBeVisible();
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
      expect(text).not.toMatch(/\bratings?\b|\breviews\b|★|\$\s?\d|€\s?\d|add to cart|signed in as|successfully installed|purchase confirmed/i);
      expect(await page.locator("a[href*='dropbox']").count()).toBe(0);
      expect(await page.locator("a[href*='/api/v1/downloads/'], a[href$='.deb'], a[href$='.ipa'], a[href$='.dmg'], a[href$='.zip']").count()).toBe(0);
      for (const buy of await page.getByRole("button", { name: "Buy Product" }).all()) await expect(buy).toBeDisabled();
    }
  });
});
