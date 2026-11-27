/**
 * A purchase started in a package manager (Sileo or Zebra), in a real browser standing in for the app's
 * web-authentication session, against the TEST Store (server/test/e2e-server.ts: TEST payments, mock HCG Connect):
 * package/<id>/purchase → the Store URL → HCG Connect sign-in → the product page → TEST checkout → the checkout return
 * page sends the browser to the Store's return endpoint, which answers sileo://payment_completed (the callback the
 * app waits for). Then the app's token sees the purchase (user_info) and may download.
 */
import { expect, test } from "@playwright/test";
import { ACCOUNT } from "./helpers";

const IDP = "http://127.0.0.1:4176";
const PKG = "com.example.fixture.quasar.unleashed";

test("a purchase from the package manager returns to it with sileo://payment_completed", async ({ page, request }) => {
  const sub = `pm-buyer-${Date.now()}`;
  // The package manager signs in (its own web-authentication session) and gets a Store-issued token.
  await request.post(`${IDP}/__test/next-user/${sub}`);
  let r = await request.get(`${ACCOUNT}/repo-api/v1/sileo/authenticate?udid=x&model=iPhone14,2`, { maxRedirects: 0 });
  r = await request.get(r.headers().location!, { maxRedirects: 0 });
  r = await request.get(r.headers().location!, { maxRedirects: 0 });
  const cb = new URL(r.headers().location!);
  expect(cb.href.startsWith("sileo://authentication_success")).toBe(true);
  const token = cb.searchParams.get("token")!;
  const pm = async (path: string, body: object) => (await (await request.post(`${ACCOUNT}/repo-api/v1/sileo/${path}`, { data: { token, ...body } })).json()) as Record<string, any>;

  const purchase = await pm(`package/${PKG}/purchase`, { payment_secret: cb.searchParams.get("payment_secret") });
  expect(purchase.status).toBe(1);

  // The app opens purchase.url in its web-authentication session (here: a browser page).
  await request.post(`${IDP}/__test/next-user/${sub}`);
  const completed = page.waitForResponse((res) => res.url().includes("/repo-api/v1/sileo/checkout/") && res.url().endsWith("/return") && res.status() === 302);
  await page.goto(purchase.url);
  await expect(page).toHaveURL(/\/apps\/fixture-quasar-shell\?edition=unleashed&buy=1&pm=/);
  const card = page.locator("#edition-unleashed");
  await card.getByRole("button", { name: "Buy Product" }).click();
  await expect(page.getByText(/TEST MODE — no real payment is taken/)).toBeVisible();
  await page.getByRole("button", { name: "Simulate successful payment" }).click();
  const back = await completed;
  expect(back.headers().location).toBe("sileo://payment_completed");

  // Restoration and delivery for the app.
  expect((await pm("user_info", {})).items).toContain(PKG);
  const auth = await pm(`package/${PKG}/authorize_download`, { version: "1.0.0", architecture: "iphoneos-arm64" });
  expect((await request.get(auth.url)).status()).toBe(200);
});
