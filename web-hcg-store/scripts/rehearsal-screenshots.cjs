// Publication preview screenshots from the rehearsal server (server/test/release-rehearsal.ts serve).
//   node scripts/rehearsal-screenshots.cjs <origin> <control origin> <out dir>
const { chromium } = require("playwright");
const [origin, control, out] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const shoot = async (name, path, { as, width = 1440, height = 900, full = true, before } = {}) => {
    const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: width < 700 ? 2 : 1 });
    const p = await ctx.newPage();
    if (as) {
      await fetch(`${control}/?as=${as}`);
      await p.goto(`${origin}/auth/login?return_to=${encodeURIComponent(path)}`, { waitUntil: "networkidle" });
    } else await p.goto(origin + path, { waitUntil: "networkidle" });
    if (before) await before(p);
    await p.waitForTimeout(800);
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo(0, 0); });
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: full });
    console.log(name, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
    await ctx.close();
  };
  await shoot("01-product-page-signed-out-1440", "/apps/hcg-mail");
  await shoot("02-product-page-tester-signed-in-1440", "/apps/hcg-mail?edition=windows-desktop", { as: "tester" });
  await shoot("03-product-page-tester-signed-in-390", "/apps/hcg-mail?edition=windows-desktop", { as: "tester", width: 390, height: 844 });
  await shoot("04-release-manager-founder-1440", "/release-manager", { as: "founder", full: false });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await fetch(`${control}/?as=founder`);
  await p.goto(`${origin}/auth/login?return_to=/release-manager`, { waitUntil: "networkidle" });
  const href = await p.locator(".rm-release a").first().getAttribute("href");
  await p.goto(href.replace(/^https?:\/\/[^/]+/, origin), { waitUntil: "networkidle" });
  await p.screenshot({ path: `${out}/05-review-page-founder-1440.png`, fullPage: true });
  await b.close();
})();
