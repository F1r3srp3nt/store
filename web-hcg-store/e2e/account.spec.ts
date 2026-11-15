import { expect, test, type Page } from "@playwright/test";
import { ACCOUNT, collectErrors } from "./helpers";

/**
 * Full browser flows against the HCG Store server in TEST mode (mock HCG Connect, TEST payment
 * provider, TEST files). Each test signs in a different person, so tests are independent.
 */
async function signIn(page: Page, sub: string, returnTo = "/library") {
  await page.request.post(`http://127.0.0.1:4176/__test/next-user/${encodeURIComponent(sub)}`);
  await page.goto(`${ACCOUNT}/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  await expect(page).toHaveURL(`${ACCOUNT}${returnTo}`);
}

const unique = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.describe("account, purchase and protected delivery (TEST mode)", () => {
  test("signed-out visitors see product information, sign-in prompts and no files", async ({ page, request }) => {
    const errors = collectErrors(page);
    await page.goto(`${ACCOUNT}/apps/fixture-quasar-shell?edition=unleashed`);
    await expect(page.getByRole("heading", { level: 1, name: "Fixture Quasar Shell" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Sign in to check access/ }).first()).toBeVisible();
    await expect(page.locator("a[href*='/api/v1/downloads/']")).toHaveCount(0);
    expect((await request.get(`${ACCOUNT}/api/v1/downloads/fixture-quasar-unleashed-1-0-0-arm64`)).status()).toBe(401);
    expect(errors).toEqual([]);
  });

  test("sign in, buy in test mode, see Owned, download the right file, sign out", async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page, unique("buyer"), "/apps/fixture-quasar-shell?edition=unleashed");
    const card = page.locator("#edition-unleashed");
    await expect(card.getByText("Not owned")).toBeVisible();
    await expect(card.getByText("€9.99")).toBeVisible();
    await card.getByRole("button", { name: "Buy Product" }).click();

    await expect(page.getByText(/TEST MODE — no real payment is taken/)).toBeVisible();
    await page.getByRole("button", { name: "Simulate successful payment" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Purchase confirmed" })).toBeVisible();

    await page.goto(`${ACCOUNT}/apps/fixture-quasar-shell?edition=unleashed`);
    await expect(card.getByText("Owned", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: /Get from HCG Repo/ })).toHaveAttribute("href", /\/products\/fixture-quasar-unleashed\/$/);
    // The other edition was not bought and stays unowned.
    await expect(page.locator("#edition-standard").getByText("Not owned")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: /quasar\.unleashed_1\.0\.0_iphoneos-arm64\.deb/ }).click()]);
    expect(download.suggestedFilename()).toBe("com.example.fixture.quasar.unleashed_1.0.0_iphoneos-arm64.deb");

    await page.goto(`${ACCOUNT}/library`);
    await expect(page.getByRole("link", { name: "Fixture Quasar Shell Unleashed" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Paid/ })).toBeVisible();

    await page.goto(`${ACCOUNT}/account`);
    await page.getByRole("button", { name: "Sign out of HCG Store" }).click();
    await expect(page.getByRole("link", { name: "Sign in with HCG Connect" })).toBeVisible();
    expect((await page.request.get(`${ACCOUNT}/api/v1/downloads/fixture-quasar-unleashed-1-0-0-arm64`)).status()).toBe(401);
    expect(errors).toEqual([]);
  });

  test("a failed payment and a forged return URL grant nothing", async ({ page }) => {
    await signIn(page, unique("failer"), "/apps/fixture-quasar-shell?edition=unleashed");
    const card = page.locator("#edition-unleashed");
    await card.getByRole("button", { name: "Buy Product" }).click();
    await page.getByRole("button", { name: "Simulate failed payment" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Payment not completed" })).toBeVisible();
    await page.goto(`${ACCOUNT}/checkout/return?checkout=chk_forged&status=success`);
    await expect(page.getByRole("heading", { level: 1, name: "Checkout not found" })).toBeVisible();
    await page.goto(`${ACCOUNT}/apps/fixture-quasar-shell?edition=unleashed`);
    await expect(card.getByText("Not owned")).toBeVisible();
    expect((await page.request.get(`${ACCOUNT}/api/v1/downloads/fixture-quasar-unleashed-1-0-0-arm64`)).status()).toBe(403);
  });

  test("the session is restored on reload and shown in the header", async ({ page }) => {
    await signIn(page, unique("returning"), "/");
    await page.reload();
    await expect(page.getByRole("link", { name: /Library/ }).first()).toBeVisible();
  });
});
