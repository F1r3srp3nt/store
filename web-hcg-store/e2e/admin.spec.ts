/**
 * HCG Store Control Center in a real browser against the TEST HCG Store (server/test/admin-e2e-server.ts): mock HCG
 * Connect sign-in, TEST grants standing in for HCG's central permissions. Uploads genuine Windows executables and a
 * macOS app ZIP through the website, interrupts an upload and resumes it after a reload, then runs the release
 * lifecycle in the browser. Screenshots go to $CONTROL_CENTER_SHOTS (default test-results/control-center).
 *
 *   ADMIN_E2E_EXE=<a genuine x64 .exe> ADMIN_E2E_EXE_ARM=<a genuine ARM64 .exe> npx playwright test e2e/admin.spec.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";

const STORE = "http://127.0.0.1:4177";
const IDP = "http://127.0.0.1:4178";
const SHOTS = process.env.CONTROL_CENTER_SHOTS ?? "test-results/control-center";
mkdirSync(SHOTS, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "hcg-cc-files-"));
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** Genuine Windows executables when provided (CI: any PE32+ file), else a minimal PE so the spec still runs. */
function exeFile(name: string, env: string | undefined): string {
  const out = join(dir, name);
  if (env && existsSync(env)) copyFileSync(env, out);
  else {
    const b = Buffer.concat([Buffer.alloc(512), randomBytes(150_000)]);
    b.write("MZ", 0, "latin1"); b.writeUInt32LE(128, 60); b.write("PE\0\0", 128, "latin1"); b.writeUInt16LE(0x20b, 152);
    writeFileSync(out, b);
  }
  return out;
}
/** A macOS .app bundle packaged as a ZIP (stored, ~6 MB, so it takes several 1 MB chunks). */
function macZip(name: string): string {
  const files = [
    { name: "Quasar.app/Contents/Info.plist", data: Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.hcg.quasar</string></dict></plist>') },
    { name: "Quasar.app/Contents/MacOS/Quasar", data: randomBytes(6 * 1024 * 1024) },
    // A signed app's seal (public macOS files must be Developer ID signed and notarized).
    { name: "Quasar.app/Contents/_CodeSignature/CodeResources", data: Buffer.from("<plist/>") },
  ];
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data, { level: 0 });
    const n = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE((0o100755 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const out = join(dir, name);
  writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return out;
}

const WIN_X64 = exeFile("QuasarSetup-1.0.0-x64.exe", process.env.ADMIN_E2E_EXE);
const WIN_X64_V2 = exeFile("QuasarSetup-1.1.0-x64.exe", process.env.ADMIN_E2E_EXE_ARM ?? process.env.ADMIN_E2E_EXE);
const MAC = macZip("Quasar-1.0.0-macOS-universal.zip");

async function grant(sub: string, what: string) {
  expect((await fetch(`${STORE}/__e2e/grant/${sub}/${encodeURIComponent(what)}`, { method: "POST" })).status).toBe(204);
}
async function signIn(browser: Browser, sub: string, returnTo = "/control-center"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  await fetch(`${IDP}/__test/next-user/${sub}`, { method: "POST" });
  const page = await ctx.newPage();
  await page.goto(`${STORE}/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  await page.waitForURL((u) => u.pathname === returnTo.split("?")[0]);
  return page;
}
const shot = async (page: Page, name: string) => {
  // Full-page captures: keep the sticky site header at the top instead of floating mid-page.
  await page.evaluate(() => document.querySelector<HTMLElement>(".site-header")?.style.setProperty("position", "static", "important"));
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test("an ordinary customer is not authorised: no upload controls", async ({ browser }) => {
  const page = await signIn(browser, "cc-customer");
  await expect(page.getByTestId("not-authorised")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await shot(page, "01-not-authorised");
  // The API refuses too: the page is not the gate.
  const r = await page.evaluate(async () => (await fetch("/api/v1/publishing/releases", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  expect(r).toBe(403);
});

let draftReleaseId = "";
test("the owner uploads a genuine EXE and a macOS ZIP through the website; the ZIP upload is interrupted, the page reloaded, and the upload resumed", async ({ browser }) => {
  await grant("cc-owner", "store.publish");
  const page = await signIn(browser, "cc-owner");
  await expect(page.getByRole("tab", { name: "Upload application" })).toBeVisible();
  await expect(page.getByText("Private uploads only")).toHaveCount(0);
  await shot(page, "02-upload-operations");

  await page.getByLabel("Product", { exact: true }).selectOption("fixture-quasar-shell");
  await page.getByLabel("Version", { exact: true }).fill("1.0.0");
  await page.getByLabel("Build", { exact: true }).fill("100");
  await page.getByLabel("Release notes (one per line)").fill("First release shipped from the HCG Store website (TEST).");
  await page.getByLabel("Known limitations (one per line)").fill("TEST build: not code-signed.");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await expect(page.getByLabel("Draft files")).toBeVisible();

  await page.getByTestId("file-input").setInputFiles([WIN_X64, MAC]);
  const rows = page.getByTestId("upload-row");
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel("x64").check();
  await expect(rows.nth(1).getByRole("combobox").first()).toHaveValue("macos");
  await rows.nth(1).getByLabel("x64").check();
  await rows.nth(1).getByLabel("arm64").check();
  // What the uploader verified on their Mac, recorded with evidence (reported; the Store also checks the seal).
  await rows.nth(1).getByLabel("Signing, as you checked it").selectOption("notarized");
  await rows.nth(1).getByLabel("Signing evidence (recorded)").fill("TEST: spctl accepted, source=Notarized Developer ID; stapler validate worked");

  // Genuine EXE: straight through.
  await rows.nth(0).getByRole("button", { name: "Upload" }).click();
  await expect(rows.nth(0).getByTestId("upload-phase")).toHaveText("Verified", { timeout: 60_000 });
  await expect(rows.nth(0).getByTestId("sha-match")).toContainText(sha(WIN_X64));
  await expect(rows.nth(0).getByTestId("sha-match")).toContainText("matches the file in this browser");

  // ZIP: slow link, pause mid-way, then the browser tab is reloaded (a crash or a closed laptop).
  await fetch(`${STORE}/__e2e/slow/700`, { method: "POST" });
  await rows.nth(1).getByRole("button", { name: "Upload" }).click();
  await expect(rows.nth(1).getByTestId("upload-phase")).toHaveText("Uploading", { timeout: 30_000 });
  await page.waitForTimeout(2200);
  await shot(page, "03-upload-in-progress");
  await page.reload();
  await fetch(`${STORE}/__e2e/slow/0`, { method: "POST" });
  await page.getByText("Continue a draft").click();
  await expect(page.getByText(/interrupted upload\(s\) in this browser/)).toBeVisible();
  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page.getByText(/^Interrupted:/)).toBeVisible();
  draftReleaseId = await page.evaluate(() => JSON.parse(localStorage.getItem("hcg-store.uploads") ?? "[]")[0].releaseId as string);
  const received = await page.evaluate(async (id) => {
    const r = await (await fetch(`/api/v1/publishing/releases/${id}`)).json();
    return r.artifacts.find((a: { fileName: string }) => a.fileName.endsWith(".zip")).receivedBytes as number;
  }, draftReleaseId);
  expect(received).toBeGreaterThan(0); // the Store kept the bytes it received before the interruption
  await page.locator("label", { hasText: "Choose the same file to resume" }).locator("input").setInputFiles(MAC);
  const resumed = page.getByTestId("upload-row").first();
  await resumed.getByRole("button", { name: "Resume" }).click();
  await expect(resumed.getByTestId("upload-phase")).toHaveText("Verified", { timeout: 60_000 });
  await expect(resumed.getByTestId("sha-match")).toContainText(sha(MAC));
  await shot(page, "04-draft-verified");

  // The same draft, as HCG Store Manager / Executable Maker see it through the same API.
  const token = (await (await fetch(`${STORE}/__e2e/desktop-token/cc-owner`, { method: "POST" })).json()) as { token: string };
  const manager = (await (await fetch(`${STORE}/api/v1/publishing/releases/${draftReleaseId}`, { headers: { authorization: `Bearer ${token.token}` } })).json()) as { artifacts: { sha256: string; status: string }[]; uploadSource: { via: string } };
  expect(manager.uploadSource.via).toBe("web");
  expect(manager.artifacts.filter((a) => a.status === "verified").map((a) => a.sha256).sort()).toEqual([sha(WIN_X64), sha(MAC)].sort());

  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("tab", { name: "Releases", selected: true })).toBeVisible();
  await expect(page.getByTestId("release-1.0.0-100").getByTestId("lifecycle")).toHaveText("submitted");
});

test("a second person approves and publishes in the browser; a Windows update supersedes only Windows; a rollback restores 1.0.0", async ({ browser }) => {
  await grant("cc-reviewer", "store.release.approve");
  await grant("cc-reviewer", "store.release.publish");
  const reviewer = await signIn(browser, "cc-reviewer", "/control-center?tab=releases");
  const card = reviewer.getByTestId("release-1.0.0-100");
  await card.getByTestId("step-approve").click();
  await card.getByLabel("Approve for").selectOption("public");
  await card.getByLabel(/Type the version/).fill("1.0.0");
  await card.getByTestId("confirm-approve").click();
  await expect(card.getByText("Approved for public.")).toBeVisible();
  await card.getByTestId("step-publish").click();
  await card.getByLabel(/Type the version/).fill("1.0.0");
  await card.getByTestId("confirm-publish").click();
  await expect(card.getByText(/Published\. Now current on:/)).toBeVisible();
  await expect(card.getByTestId("lifecycle")).toHaveText("current");

  // Owner prepares 1.1.0 for Windows x64, set to supersede the previous compatible release once published.
  const owner = await signIn(browser, "cc-owner");
  await owner.getByLabel("Product", { exact: true }).selectOption("fixture-quasar-shell");
  await owner.getByLabel("Version", { exact: true }).fill("1.1.0");
  await owner.getByLabel("Build", { exact: true }).fill("110");
  await owner.getByLabel("Release notes (one per line)").fill("Windows update (TEST).");
  await expect(owner.getByLabel(/Supersede previous compatible release/)).toBeChecked();
  await owner.getByRole("button", { name: "Create private draft" }).click();
  await owner.getByTestId("file-input").setInputFiles(WIN_X64_V2);
  const row = owner.getByTestId("upload-row").first();
  await row.getByLabel("x64").check();
  await row.getByRole("button", { name: "Upload" }).click();
  await expect(row.getByTestId("upload-phase")).toHaveText("Verified", { timeout: 60_000 });
  await owner.getByRole("button", { name: "Submit for review" }).click();

  await reviewer.reload();
  const v2 = reviewer.getByTestId("release-1.1.0-110");
  await v2.getByTestId("step-approve").click();
  await v2.getByLabel("Approve for").selectOption("public");
  await v2.getByLabel(/Type the version/).fill("1.1.0");
  await v2.getByTestId("confirm-approve").click();
  await v2.getByTestId("step-publish").click();
  await expect(v2.getByLabel(/Supersede the previous compatible release/)).toBeChecked();
  await v2.getByLabel(/Type the version/).fill("1.1.0");
  await v2.getByTestId("confirm-publish").click();
  await expect(v2.getByText(/Now current on: Windows x64 \(stable\)/)).toBeVisible();
  await reviewer.reload();
  // macOS keeps 1.0.0; Windows is 1.1.0.
  const v1 = reviewer.getByTestId("release-1.0.0-100");
  await expect(v1.getByText("macOS arm64 · stable · current")).toBeVisible();
  await expect(v1.getByText("Windows x64 · stable", { exact: true })).toBeVisible();
  await expect(reviewer.getByTestId("release-1.1.0-110").getByText("Windows x64 · stable · current")).toBeVisible();
  await shot(reviewer, "05-releases-per-platform-current");

  // Products: the current release of each platform.
  await reviewer.getByRole("tab", { name: "Products" }).click();
  await reviewer.getByRole("button", { name: /Fixture Quasar Shell/ }).click();
  await expect(reviewer.getByRole("cell", { name: "1.1.0 build 110" })).toBeVisible();
  await shot(reviewer, "06-product-manager");

  // Rollback: disable 1.1.0, then restore 1.0.0 on every platform it serves.
  await reviewer.getByRole("tab", { name: "Releases" }).click();
  const bad = reviewer.getByTestId("release-1.1.0-110");
  await bad.getByRole("button", { name: "Disable" }).click();
  await bad.getByLabel("Reason (recorded)").fill("Crashes on start (TEST).");
  await bad.getByRole("button", { name: "Disable" }).last().click();
  await expect(bad.getByTestId("lifecycle")).toHaveText("disabled");
  const old = reviewer.getByTestId("release-1.0.0-100");
  await old.getByRole("button", { name: "Restore this version" }).click();
  await old.getByLabel("Reason (recorded)").fill("Roll back to 1.0.0 (TEST).");
  await old.getByLabel(/Type the version/).fill("1.0.0");
  await old.getByRole("button", { name: "Restore this version" }).last().click();
  await expect(old.getByText(/Restored\. Now current on: Windows x64 \(stable\)/)).toBeVisible();
  await old.getByRole("button", { name: "Details and history" }).click();
  await expect(old.getByText("release.restored")).toBeVisible();
  await shot(reviewer, "07-rollback-restored");

  // Customers: 1.0.0 downloads for Windows again; the disabled 1.1.0 does not.
  await grant("cc-customer2", "licence:fixture.quasar.shell:standard");
  const customer = await signIn(browser, "cc-customer2", "/apps/fixture-quasar-shell");
  const access = await customer.evaluate(async () => (await (await fetch("/api/v1/products/fixture-quasar-shell/access")).json()) as { editions: { editionId: string; artifacts: { id: string; fileName: string }[] }[] });
  const offered = access.editions.find((e) => e.editionId === "standard")!.artifacts.filter((a) => a.id.startsWith("art-")).map((a) => a.fileName).sort();
  expect(offered).toEqual(["Quasar-1.0.0-macOS-universal.zip", "QuasarSetup-1.0.0-x64.exe"]);
  await expect(customer.getByTestId("manage-product")).toHaveCount(0);
  const admin = await signIn(browser, "cc-reviewer", "/apps/fixture-quasar-shell");
  await expect(admin.getByTestId("manage-product")).toBeVisible();
  await shot(admin, "08-product-page-manage");
});

test("the Control Center renders in all six HCG Store themes", async ({ browser }) => {
  const page = await signIn(browser, "cc-reviewer", "/control-center?tab=releases");
  for (const theme of ["sovereign", "cyberpunk", "crimson", "founder", "frost", "horizon"]) {
    await page.evaluate((t) => localStorage.setItem("hcg-store.theme", t), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("release-1.0.0-100")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `09-theme-${theme}.png`) });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Complete website release lifecycle (founder exception, readiness, signing, review decisions). Same serial chain as
// above: one mock HCG Connect, one TEST Store, never two sign-ins at once.
const FOUNDER = `rx-founder-${Date.now()}`;
const REVIEWER = `rx-reviewer-${Date.now()}`;

function rxExe(name: string): string {
  const b = Buffer.concat([Buffer.alloc(512), randomBytes(120_000)]);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(128, 60); b.write("PE\0\0", 128, "latin1"); b.writeUInt16LE(0x20b, 152);
  const out = join(dir, name);
  writeFileSync(out, b);
  return out;
}
function unsignedMacZip(name: string): string {
  const files = [{ name: "Quasar.app/Contents/Info.plist", data: Buffer.from("<plist/>") }, { name: "Quasar.app/Contents/MacOS/Quasar", data: randomBytes(40_000) }];
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data);
    const n = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE((0o100755 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const out = join(dir, name);
  writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return out;
}

async function control(path: string) {
  expect((await fetch(`${STORE}${path}`, { method: "POST" })).status).toBe(204);
}
async function signInAs(browser: Browser, sub: string, returnTo = "/control-center"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  await fetch(`${IDP}/__test/next-user/${sub}`, { method: "POST" });
  const page = await ctx.newPage();
  await page.goto(`${STORE}/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  await page.waitForURL((u) => u.pathname === returnTo.split("?")[0]);
  return page;
}
const shotOf = async (page: Page, name: string, el?: ReturnType<Page["getByTestId"]>) => {
  await page.evaluate(() => document.querySelector<HTMLElement>(".site-header")?.style.setProperty("position", "static", "important"));
  if (el) await el.screenshot({ path: join(SHOTS, `${name}.png`) });
  else await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
async function createDraft(page: Page, version: string, build: string, file: string, mac = false) {
  await page.getByRole("tab", { name: "Upload application" }).click();
  await page.getByLabel("Product", { exact: true }).selectOption("fixture-quasar-shell");
  await page.getByLabel("Version", { exact: true }).fill(version);
  await page.getByLabel("Build", { exact: true }).fill(build);
  await page.getByLabel("Release notes (one per line)").fill(`TEST ${version}: website-administered release.`);
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page.getByTestId("file-input").setInputFiles(file);
  const row = page.getByTestId("upload-row").first();
  await row.getByLabel(mac ? "arm64" : "x64").check();
  await row.getByRole("button", { name: "Upload" }).click();
  await expect(row.getByTestId("upload-phase")).toHaveText("Verified", { timeout: 60_000 });
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("tab", { name: "Releases", selected: true })).toBeVisible();
}


test("the Founder submits their own release; the inspector explains why approval waits, and resolves it with the audited founder exception", async ({ browser }) => {
  for (const p of ["store.publish", "store.release.approve", "store.release.publish"]) await control(`/__e2e/grant/${FOUNDER}/${p}`);
  await control(`/__e2e/founder/${FOUNDER}`);
  const page = await signInAs(browser, FOUNDER);
  await createDraft(page, "7.0.0", "700", rxExe("Quasar-7.0.0-x64.exe"));
  const card = page.getByTestId("release-7.0.0-700");
  const inspector = card.getByTestId("readiness");
  await expect(inspector).toBeVisible();
  // Approval is not silently missing: it is listed, disabled, with the reason and the resolution.
  const approve = inspector.locator('[data-step="approve"]');
  await expect(approve.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(approve.getByTestId("why-approve")).toContainText("founder-operated exception");
  await expect(inspector).toContainText("HCG confirms the Founder policy for your account");
  await shotOf(page, "10-readiness-approval-waits", inspector);

  await approve.getByTestId("resolve-approve").click();
  const form = inspector.locator('[data-step="founderException"]');
  await expect(form).toContainText("not an independent review");
  await form.getByLabel("Reason (recorded)").fill("TEST: the Founder releases their own build");
  await form.getByLabel(/I understand this is not an independent review/).check();
  await form.getByLabel(/Type the version/).fill("7.0.0");
  await shotOf(page, "11-founder-exception-form", inspector);
  await form.getByTestId("confirm-founderException").click();
  await expect(card.getByText(/Founder exception rx-[a-f0-9]+ recorded for these exact files/)).toBeVisible();
  await expect(card.getByTestId("founder-exception")).toBeVisible();

  await inspector.getByTestId("step-approve").click();
  await inspector.getByLabel("Approve for").selectOption("public");
  await inspector.getByLabel(/Type the version/).fill("7.0.0");
  await inspector.getByTestId("confirm-approve").click();
  await expect(card.getByText("Approved for public.")).toBeVisible();
  await inspector.getByTestId("step-publish").click();
  await inspector.getByLabel(/Type the version/).fill("7.0.0");
  await inspector.getByTestId("confirm-publish").click();
  await expect(card.getByText(/Published\. Now current on: Windows x64/)).toBeVisible();
  await expect(card.getByTestId("lifecycle")).toHaveText("current");
  // History and audit: the exception, approval and publication are recorded under the Founder.
  await card.getByRole("button", { name: "Details and history" }).click();
  await expect(card.locator(".cc-audit")).toContainText("release.exception-granted");
  await expect(card.locator(".cc-audit")).toContainText("release.published");
  await shotOf(page, "12-founder-published", card);
});

test("unsigned macOS files are never approved for the public, not even with a founder exception; the reason is shown", async ({ browser }) => {
  const page = await signInAs(browser, FOUNDER, "/control-center");
  await createDraft(page, "7.1.0", "710", unsignedMacZip("Quasar-7.1.0-macOS.zip"), true);
  const inspector = page.getByTestId("release-7.1.0-710").getByTestId("readiness");
  await expect(inspector).toContainText("do not meet public signing requirements");
  const ex = inspector.locator('[data-step="founderException"]');
  await expect(ex.getByRole("button", { name: "Record founder exception" })).toBeDisabled();
  await expect(ex.getByTestId("why-founderException")).toContainText("never changes them");
  await shotOf(page, "13-unsigned-macos-refused", inspector);
});

test("a reviewer requests changes and rejects with recorded reasons; an ordinary customer gets no administration", async ({ browser }) => {
  for (const p of ["store.release.approve", "store.release.publish"]) await control(`/__e2e/grant/${REVIEWER}/${p}`);
  const founder = await signInAs(browser, FOUNDER, "/control-center");
  await createDraft(founder, "7.2.0", "720", rxExe("Quasar-7.2.0-x64.exe"));
  const reviewer = await signInAs(browser, REVIEWER, "/control-center?tab=releases");
  const card = reviewer.getByTestId("release-7.2.0-720");
  const inspector = card.getByTestId("readiness");
  // An independent reviewer: approval is available, no exception is involved.
  await expect(inspector.getByTestId("step-approve")).toBeEnabled();
  await inspector.getByTestId("step-requestChanges").click();
  await inspector.getByLabel("Review reason (recorded)").fill("TEST: add known limitations");
  await inspector.getByTestId("confirm-requestChanges").click();
  await expect(card.getByText("Returned to draft for changes")).toBeVisible();
  await expect(card.getByTestId("lifecycle")).not.toHaveText("submitted");
  await expect(inspector).toContainText("TEST: add known limitations");

  // The Founder edits and resubmits; the reviewer rejects.
  await founder.goto(`${STORE}/control-center?tab=releases`);
  const fi = founder.getByTestId("release-7.2.0-720").getByTestId("readiness");
  await fi.getByTestId("step-edit").click();
  await fi.getByLabel("Known limitations (one per line)").fill("TEST: none known.");
  await fi.getByTestId("confirm-edit").click();
  await expect(founder.getByText("Release details saved.")).toBeVisible();
  await fi.getByTestId("step-submit").click();
  await fi.getByTestId("confirm-submit").click();
  await expect(founder.getByText("Submitted for review.")).toBeVisible();
  await reviewer.reload();
  await inspector.getByTestId("step-reject").click();
  await inspector.getByLabel("Review reason (recorded)").fill("TEST: wrong build");
  await inspector.getByTestId("confirm-reject").click();
  await expect(card.getByText("Rejected (recorded with your reason).")).toBeVisible();
  await expect(card.getByTestId("lifecycle")).toHaveText("withdrawn");

  const customer = await signInAs(browser, `rx-customer-${Date.now()}`);
  await expect(customer.getByTestId("not-authorised")).toBeVisible();
  const r = await customer.evaluate(async () => (await fetch("/api/v1/publishing/manager")).json());
  expect(r.releases).toEqual([]);
});

// Payment Provider Studio (Sileo / Zebra). Same serial chain: the Founder (HCG's Founder policy) manages it; an
// administrator without Pricing and Offers or the Founder policy can only view it; customers cannot reach it.
test("the Founder configures the Sileo payment provider in the Payment Provider Studio; health and the Sileo preview follow", async ({ browser }) => {
  const page = await signInAs(browser, FOUNDER, "/control-center?tab=payments");
  const studio = page.getByTestId("payment-provider-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("studio-availability")).toHaveText("Disabled");
  await expect(studio.getByTestId("studio-name")).toHaveValue("HCG Store");
  const preview = studio.getByTestId("sileo-preview");
  await expect(preview).toContainText("Official payment and distribution services for Hakmi Capital Group.");
  await expect(preview).toContainText("Sign in with HCG Connect");
  await expect(studio.getByTestId("studio-health-checks")).toContainText("Provider available");
  await studio.getByTestId("studio-availability-select").selectOption("internal");
  await studio.getByTestId("studio-save").click();
  await expect(studio.getByTestId("studio-message")).toContainText("Saved");
  await expect(studio.getByTestId("studio-availability")).toHaveText("Internal testing");
  // The repository package of the fixture's Unleashed edition (the catalogue declares the Debian identifier).
  await studio.getByRole("button", { name: "Add a repository package" }).click();
  const form = studio.getByTestId("channel-form");
  await form.getByLabel("Status").selectOption("active");
  await form.getByRole("button", { name: "Save channel" }).click();
  await expect(studio.getByTestId("studio-channel-table")).toContainText("com.example.fixture.quasar.unleashed");
  await expect(studio.getByTestId("studio-channel-table")).toContainText("No offer is approved for sale");
  await shotOf(page, "20-payment-provider-studio", studio);
  // What a package manager receives now (internal testing): the official profile.
  const info = await (await fetch(`${STORE}/api/sileo/v1/info`)).json();
  expect(info).toMatchObject({ name: "HCG Store", authentication_banner: { button: "Sign in with HCG Connect" } });
  await page.getByRole("tab", { name: "Developers & sales" }).click();
  await expect(page.getByTestId("developers-panel")).toContainText("payouts off");
  await shotOf(page, "21-developers-and-sales", page.getByTestId("developers-panel"));

  const customer = await signInAs(browser, `pp-customer-${Date.now()}`);
  const denied = await customer.evaluate(async () => (await fetch("/api/v1/commerce/overview")).status);
  expect(denied).toBe(403);
});
