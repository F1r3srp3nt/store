import { expect, test } from "@playwright/test";
import { collectErrors, FIXTURE } from "./helpers";

test.describe("downloads (test fixture catalogue)", () => {
  test("fixture build is clearly labelled", async ({ page }) => {
    await page.goto(FIXTURE + "/");
    await expect(page.getByRole("note").filter({ hasText: "Test fixture data" })).toBeVisible();
  });

  test("download is a normal navigation to Dropbox with dl=1 and rlkey preserved", async ({ page }) => {
    const errors = collectErrors(page);
    // Never contact Dropbox from tests: answer the navigation locally like a real file response.
    await page.route("https://www.dropbox.com/**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="fixture.zip"' },
        body: "fixture",
      }),
    );
    await page.goto(FIXTURE + "/apps/fixture-orbit-notes");
    const link = page.getByRole("link", { name: /^Download ZIP archive/ });
    await expect(link).not.toHaveAttribute("download", /.*/);

    const [request] = await Promise.all([page.waitForRequest(/dropbox\.com/), link.click()]);
    const url = new URL(request.url());
    expect(url.pathname).toBe("/scl/fi/FIXTURE0win0000000000/fixture-orbit-notes-1.10.0-win-x64.zip");
    expect(url.searchParams.get("dl")).toBe("1");
    expect(url.searchParams.get("rlkey")).toBe("FIXTUREONLYwin");
    expect(url.searchParams.get("st")).toBe("fixture1");
    expect(request.isNavigationRequest()).toBe(true);

    await expect(page.getByText(/Download requested from Dropbox/)).toBeVisible();
    await expect(page.getByText(/cannot confirm it finished or that anything was installed/)).toBeVisible();
    await expect(page).toHaveURL(/fixture-orbit-notes$/); // the store page stays open
    expect(errors.filter((e) => !/net::ERR_ABORTED/.test(e))).toEqual([]);
  });

  test("raw=1 is removed for the macOS artifact", async ({ page }) => {
    await page.goto(FIXTURE + "/apps/fixture-orbit-notes");
    const href = await page.getByRole("link", { name: /^Download macOS disk image/ }).getAttribute("href");
    const url = new URL(href!);
    expect(url.searchParams.get("dl")).toBe("1");
    expect(url.searchParams.has("raw")).toBe(false);
    expect(url.searchParams.get("rlkey")).toBe("FIXTUREONLYmac");
  });

  test("withdrawn releases have no download links", async ({ page }) => {
    await page.goto(FIXTURE + "/apps/fixture-orbit-notes/releases");
    const withdrawn = page.locator(".history-item--withdrawn");
    await expect(withdrawn).toHaveCount(1);
    await expect(withdrawn.getByRole("link", { name: /^Download/ })).toHaveCount(0);
    await expect(withdrawn.getByText("Withdrawn — download disabled.")).toBeVisible();
  });

  test("missing images fall back to a readable placeholder", async ({ page }) => {
    await page.goto(FIXTURE + "/apps/fixture-nebula-pad");
    await expect(page.getByRole("img", { name: "Image unavailable: Missing fixture image" })).toBeVisible();
    await expect(page.getByText("No public release supplied").first()).toBeVisible();
  });

  test("checksum can be copied", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(FIXTURE + "/apps/fixture-orbit-notes");
    await page.getByRole("button", { name: "Copy SHA-256 checksum" }).first().click();
    await expect(page.getByText("Copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("3f1d2c0b5a4e6f7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d");
  });
});
